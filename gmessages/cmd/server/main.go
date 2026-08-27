// gmessages adapter, based on mautrix-gmessages v0.2608.0.
// Copyright (C) 2026 gmessages-cf contributors.
// This file is licensed under the GNU AGPL version 3 or later.

package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog"
	"go.mau.fi/mautrix-gmessages/pkg/libgm"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/events"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
)

type server struct {
	client      *libgm.Client
	token       string
	subscribers map[chan serverEvent]struct{}
	lifecycle   lifecycleState
	pairing     bool
	pairingURL  string
	pairingFail bool
	mu          sync.Mutex
}

type lifecycleState string

const (
	lifecycleDisconnected lifecycleState = "disconnected"
	lifecyclePaired       lifecycleState = "paired"
	lifecycleReauth       lifecycleState = "reauthentication_required"
	lifecycleUnpaired     lifecycleState = "unpaired"
)

type serverEvent struct {
	ID      string
	Payload map[string]any
}

type errorResponse struct {
	Error struct {
		Code      string `json:"code"`
		Message   string `json:"message"`
		Retryable bool   `json:"retryable"`
	} `json:"error"`
}

type sendRequest struct {
	Text           string `json:"text"`
	IdempotencyKey string `json:"idempotencyKey"`
}

type sessionRequest struct {
	Ciphertext string `json:"ciphertext"`
}

func main() {
	if _, err := decodeSessionKey(os.Getenv("LIBGM_SESSION_KEY")); err != nil {
		panic("invalid LIBGM_SESSION_KEY")
	}
	logger := zerolog.New(io.Discard)
	adapter := &server{
		client:      libgm.NewClient(libgm.NewAuthData(), nil, logger),
		lifecycle:   lifecycleUnpaired,
		token:       os.Getenv("LIBGM_IPC_TOKEN"),
		subscribers: make(map[chan serverEvent]struct{}),
	}
	adapter.client.SetEventHandler(adapter.handleEvent)
	server := &http.Server{
		Addr:              "127.0.0.1:" + envOr("PORT", "8787"),
		Handler:           adapter,
		ReadHeaderTimeout: 10 * 1000000000,
	}
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		panic(err)
	}
}

func envOr(name, fallback string) string {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	return value
}

func (s *server) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.URL.Path == "/healthz" {
		s.mu.Lock()
		lifecycle := s.lifecycle
		s.mu.Unlock()
		writeJSON(writer, http.StatusOK, map[string]any{
			"connected":                s.client.IsConnected(),
			"lifecycle":                lifecycle,
			"paired":                   lifecycle == lifecyclePaired,
			"reauthenticationRequired": lifecycle == lifecycleReauth,
			"status":                   "healthy",
		})
		return
	}
	if s.token == "" || request.Header.Get("Authorization") != "Bearer "+s.token {
		writeError(writer, http.StatusUnauthorized, "unauthorized", false)
		return
	}
	switch {
	case request.Method == http.MethodPost && request.URL.Path == "/v1/connect":
		s.connect(writer, request)
	case request.Method == http.MethodPost && request.URL.Path == "/v1/pair/start":
		s.startPairing(writer)
	case request.Method == http.MethodGet && request.URL.Path == "/v1/pair/status":
		s.pairingStatus(writer)
	case request.Method == http.MethodGet && request.URL.Path == "/v1/session/export":
		s.exportSession(writer)
	case request.Method == http.MethodPost && request.URL.Path == "/v1/session/import":
		s.importSession(writer, request)
	case request.Method == http.MethodGet && request.URL.Path == "/v1/events":
		s.events(writer, request)
	case request.Method == http.MethodGet && request.URL.Path == "/v1/conversations":
		s.conversations(writer, request)
	case request.Method == http.MethodGet && strings.HasPrefix(request.URL.Path, "/v1/conversations/"):
		s.messages(writer, request)
	case request.Method == http.MethodPost && strings.HasPrefix(request.URL.Path, "/v1/conversations/"):
		s.send(writer, request)
	default:
		writeError(writer, http.StatusNotFound, "not_found", false)
	}
}

func (s *server) handleEvent(event any) {
	s.mu.Lock()
	s.updateLifecycle(event)
	s.mu.Unlock()
	message, ok := event.(*libgm.WrappedMessage)
	if !ok || message.Message == nil {
		return
	}
	serverEvent := serverEvent{
		ID:      message.GetMessageID(),
		Payload: normalizedMessage(message.Message),
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for subscriber := range s.subscribers {
		select {
		case subscriber <- serverEvent:
		default:
		}
	}
}

func (s *server) updateLifecycle(event any) {
	switch event.(type) {
	case *events.PairSuccessful, *events.ClientReady:
		s.pairing = false
		s.pairingURL = ""
		s.pairingFail = false
		s.lifecycle = lifecyclePaired
	case *events.GaiaLoggedOut:
		s.lifecycle = lifecycleReauth
	case *events.ListenFatalError:
		s.lifecycle = lifecycleDisconnected
	}
}

func (s *server) startPairing(writer http.ResponseWriter) {
	s.mu.Lock()
	if s.lifecycle == lifecyclePaired || s.pairing {
		s.mu.Unlock()
		writeError(writer, http.StatusConflict, "pairing_in_progress", false)
		return
	}
	s.pairing = true
	s.pairingURL = ""
	s.pairingFail = false
	s.mu.Unlock()
	go func() {
		qrURL, err := s.client.StartLogin()
		s.mu.Lock()
		defer s.mu.Unlock()
		if err != nil {
			s.pairing = false
			s.pairingFail = true
			s.lifecycle = lifecycleUnpaired
			return
		}
		if s.lifecycle == lifecyclePaired {
			return
		}
		s.pairingURL = qrURL
	}()
	writeJSON(writer, http.StatusAccepted, map[string]any{"status": "pairing"})
}

func (s *server) pairingStatus(writer http.ResponseWriter) {
	s.mu.Lock()
	lifecycle := s.lifecycle
	pairing := s.pairing
	pairingURL := s.pairingURL
	pairingFail := s.pairingFail
	s.mu.Unlock()
	response := map[string]any{
		"connected": s.client.IsConnected(),
		"paired":    lifecycle == lifecyclePaired,
		"pairing":   pairing,
		"status":    lifecycle,
	}
	if pairingURL != "" {
		response["qrUrl"] = pairingURL
	}
	if pairingFail {
		response["error"] = "pairing_unavailable"
	}
	writeJSON(writer, http.StatusOK, response)
}

func (s *server) events(writer http.ResponseWriter, request *http.Request) {
	flusher, ok := writer.(http.Flusher)
	if !ok {
		writeError(writer, http.StatusInternalServerError, "streaming_unavailable", false)
		return
	}
	channel := make(chan serverEvent, 16)
	s.mu.Lock()
	s.subscribers[channel] = struct{}{}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.subscribers, channel)
		s.mu.Unlock()
	}()
	writer.Header().Set("Cache-Control", "no-cache")
	writer.Header().Set("Connection", "keep-alive")
	writer.Header().Set("Content-Type", "text/event-stream")
	writer.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(writer, ": connected\n\n")
	flusher.Flush()
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-request.Context().Done():
			return
		case event := <-channel:
			data, err := json.Marshal(event.Payload)
			if err != nil {
				continue
			}
			_, _ = fmt.Fprintf(writer, "id: %s\nevent: message\ndata: %s\n\n", event.ID, data)
			flusher.Flush()
		case <-ticker.C:
			_, _ = io.WriteString(writer, ": keepalive\n\n")
			flusher.Flush()
		}
	}
}

func (s *server) exportSession(writer http.ResponseWriter) {
	ciphertext, err := encryptSession(s.client.AuthData, os.Getenv("LIBGM_SESSION_KEY"))
	if err != nil {
		writeError(writer, http.StatusServiceUnavailable, "session_persistence_unavailable", false)
		return
	}
	writeJSON(writer, http.StatusOK, sessionRequest{Ciphertext: ciphertext})
}

func (s *server) importSession(writer http.ResponseWriter, request *http.Request) {
	var input sessionRequest
	if err := json.NewDecoder(http.MaxBytesReader(writer, request.Body, 128*1024)).Decode(&input); err != nil || input.Ciphertext == "" {
		writeError(writer, http.StatusBadRequest, "invalid_session", false)
		return
	}
	authData, err := decryptSession(input.Ciphertext, os.Getenv("LIBGM_SESSION_KEY"))
	if err != nil {
		writeError(writer, http.StatusServiceUnavailable, "session_persistence_unavailable", false)
		return
	}
	s.client.AuthData = authData
	writeJSON(writer, http.StatusOK, map[string]any{"imported": true})
}

func encryptSession(authData *libgm.AuthData, encodedKey string) (string, error) {
	key, err := decodeSessionKey(encodedKey)
	if err != nil {
		return "", err
	}
	plaintext, err := json.Marshal(authData)
	if err != nil {
		return "", fmt.Errorf("marshal session: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nonce, nonce, plaintext, nil)
	return base64.RawURLEncoding.EncodeToString(sealed), nil
}

func decryptSession(encoded, encodedKey string) (*libgm.AuthData, error) {
	key, err := decodeSessionKey(encodedKey)
	if err != nil {
		return nil, err
	}
	sealed, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("decode session: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(sealed) < gcm.NonceSize() {
		return nil, fmt.Errorf("session ciphertext is too short")
	}
	nonce, ciphertext := sealed[:gcm.NonceSize()], sealed[gcm.NonceSize():]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, fmt.Errorf("decrypt session: %w", err)
	}
	var authData libgm.AuthData
	if err := json.Unmarshal(plaintext, &authData); err != nil {
		return nil, fmt.Errorf("unmarshal session: %w", err)
	}
	return &authData, nil
}

func decodeSessionKey(encoded string) ([]byte, error) {
	key, err := base64.RawStdEncoding.DecodeString(encoded)
	if err != nil || len(key) != 32 {
		return nil, fmt.Errorf("session key must be a base64-encoded 32-byte value")
	}
	return key, nil
}

func conversationID(request *http.Request) string {
	return path.Base(request.URL.Path)
}

func (s *server) messages(writer http.ResponseWriter, request *http.Request) {
	response, err := s.client.FetchMessages(context.Background(), conversationID(request), 100, nil)
	if err != nil {
		writeError(writer, http.StatusServiceUnavailable, "provider_failure", true)
		return
	}
	result := make([]map[string]any, 0, len(response.GetMessages()))
	for _, message := range response.GetMessages() {
		result = append(result, normalizedMessage(message))
	}
	writeJSON(writer, http.StatusOK, map[string]any{"messages": result})
}

func (s *server) send(writer http.ResponseWriter, request *http.Request) {
	var input sendRequest
	if err := json.NewDecoder(http.MaxBytesReader(writer, request.Body, 4096)).Decode(&input); err != nil || input.Text == "" || input.IdempotencyKey == "" {
		writeError(writer, http.StatusBadRequest, "invalid_input", false)
		return
	}
	tmpID := providerMessageID(conversationID(request), input.IdempotencyKey)
	_, err := s.client.SendMessage(context.Background(), &gmproto.SendMessageRequest{
		ConversationID: conversationID(request),
		MessagePayload: &gmproto.MessagePayload{
			ConversationID: conversationID(request),
			TmpID:          tmpID,
			MessagePayloadContent: &gmproto.MessagePayloadContent{
				MessageContent: &gmproto.MessageContent{Content: input.Text},
			},
		},
		TmpID: tmpID,
	})
	if err != nil {
		writeError(writer, http.StatusServiceUnavailable, "provider_failure", true)
		return
	}
	writeJSON(writer, http.StatusOK, normalizedOutboundMessage(conversationID(request), tmpID, input.Text))
}

func providerMessageID(conversationID, idempotencyKey string) string {
	return uuid.NewSHA1(
		uuid.NameSpaceURL,
		[]byte(conversationID+"\x00"+idempotencyKey),
	).String()
}

func normalizedMessage(message *gmproto.Message) map[string]any {
	text := ""
	for _, info := range message.GetMessageInfo() {
		if content := info.GetMessageContent(); content != nil {
			text = content.GetContent()
			break
		}
	}
	return map[string]any{
		"conversationId": message.GetConversationID(),
		"externalId":     message.GetMessageID(),
		"id":             message.GetMessageID(),
		"outgoing":       false,
		"senderId":       message.GetParticipantID(),
		"sentAt":         time.UnixMilli(message.GetTimestamp()).UTC().Format(time.RFC3339Nano),
		"text":           text,
		"transport":      "rcs",
	}
}

func normalizedOutboundMessage(conversationID, messageID, text string) map[string]any {
	return map[string]any{
		"conversationId": conversationID,
		"externalId":     messageID,
		"id":             messageID,
		"outgoing":       true,
		"senderId":       "self",
		"sentAt":         time.Now().UTC().Format(time.RFC3339Nano),
		"text":           text,
		"transport":      "rcs",
	}
}

func (s *server) connect(writer http.ResponseWriter, request *http.Request) {
	if err := s.client.Connect(); err != nil {
		s.mu.Lock()
		if s.client.AuthData.Browser == nil {
			s.lifecycle = lifecycleUnpaired
		} else {
			s.lifecycle = lifecycleReauth
		}
		s.mu.Unlock()
		writeError(writer, http.StatusServiceUnavailable, "not_connected", true)
		return
	}
	s.mu.Lock()
	s.lifecycle = lifecyclePaired
	s.mu.Unlock()
	writeJSON(writer, http.StatusOK, map[string]any{"connected": true, "status": "connected"})
}

func (s *server) conversations(writer http.ResponseWriter, request *http.Request) {
	conversations, err := s.client.ListConversations(context.Background(), 100, 0)
	if err != nil {
		writeError(writer, http.StatusServiceUnavailable, "provider_failure", true)
		return
	}
	result := make([]map[string]any, 0, len(conversations.GetConversations()))
	for _, conversation := range conversations.GetConversations() {
		result = append(result, map[string]any{
			"id":          conversation.GetConversationID(),
			"title":       conversation.GetName(),
			"unread":      conversation.GetUnread(),
			"updatedAtMs": conversation.GetLastMessageTimestamp(),
		})
	}
	writeJSON(writer, http.StatusOK, map[string]any{"conversations": result})
}

func writeError(writer http.ResponseWriter, status int, code string, retryable bool) {
	response := errorResponse{}
	response.Error.Code = code
	response.Error.Message = strings.ReplaceAll(code, "_", " ")
	response.Error.Retryable = retryable
	writeJSON(writer, status, response)
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

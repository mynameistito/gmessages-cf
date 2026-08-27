package main

import (
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rs/zerolog"
	"go.mau.fi/mautrix-gmessages/pkg/libgm"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/events"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/gmproto"
)

func newTestServer() *server {
	return &server{
		client:      libgm.NewClient(libgm.NewAuthData(), nil, zerolog.New(io.Discard)),
		token:       "test-token",
		subscribers: make(map[chan serverEvent]struct{}),
	}
}

func TestHealthDoesNotExposeSecrets(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	recorder := httptest.NewRecorder()

	newTestServer().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected health status 200, got %d", recorder.Code)
	}
	if body := recorder.Body.String(); body == "" || bodyContainsSecret(body) {
		t.Fatalf("health response contains unsafe data: %q", body)
	}
}

func TestLifecycleStateDoesNotExposeProviderDetails(t *testing.T) {
	adapter := newTestServer()
	adapter.handleEvent(&events.GaiaLoggedOut{})

	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	recorder := httptest.NewRecorder()
	adapter.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected health status 200, got %d", recorder.Code)
	}
	body := recorder.Body.String()
	if !strings.Contains(body, `"reauthenticationRequired":true`) {
		t.Fatalf("expected reauthentication state, got %q", body)
	}
	if strings.Contains(body, "GaiaLoggedOut") {
		t.Fatalf("health response leaked provider details: %q", body)
	}
}

func TestBrowserActiveMarksClientReady(t *testing.T) {
	adapter := newTestServer()
	adapter.handleEvent(&gmproto.UserAlertEvent{AlertType: gmproto.AlertType_BROWSER_ACTIVE})

	adapter.mu.Lock()
	ready := adapter.ready
	lifecycle := adapter.lifecycle
	adapter.mu.Unlock()
	if !ready || lifecycle != lifecyclePaired {
		t.Fatalf("expected browser-active event to mark client ready, got ready=%t lifecycle=%q", ready, lifecycle)
	}
}

func TestProtectedEndpointsRequireInternalToken(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/v1/conversations", nil)
	recorder := httptest.NewRecorder()

	newTestServer().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected unauthorized status 401, got %d", recorder.Code)
	}
}

func TestAccountPairingRejectsMissingCookies(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/v1/pair/account/start", strings.NewReader(`{"cookies":{}}`))
	request.Header.Set("Authorization", "Bearer test-token")
	recorder := httptest.NewRecorder()

	newTestServer().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected bad request status 400, got %d", recorder.Code)
	}
}

func TestPairingErrorsIdentifySafeFailureStage(t *testing.T) {
	tests := map[string]string{
		"failed to prepare gaia pairing: malformed response": "google_pairing_sign_in_failed",
		"failed to send client init: connection closed":      "google_pairing_initialization_failed",
		"error processing server init: invalid key":          "google_pairing_handshake_failed",
		"failed to send client finish: connection closed":    "google_pairing_confirmation_failed",
	}
	for message, expected := range tests {
		if actual := classifyPairingError(errors.New(message)); actual != expected {
			t.Fatalf("expected %q for %q, got %q", expected, message, actual)
		}
	}
	unknown := "unknown error pairing: provider secret"
	if actual := classifyPairingError(errors.New(unknown)); actual == "" || strings.Contains(actual, "provider secret") {
		t.Fatalf("expected non-empty safe QR failure, got %q", actual)
	}
}

func TestConversationIDRoutes(t *testing.T) {
	tests := []struct {
		name string
		path string
		want string
		ok   bool
	}{
		{name: "normal", path: "/v1/conversations/abc/messages", want: "abc", ok: true},
		{name: "encoded", path: "/v1/conversations/abc%2F123/messages", want: "abc/123", ok: true},
		{name: "missing id", path: "/v1/conversations//messages", ok: false},
		{name: "missing messages", path: "/v1/conversations/abc", ok: false},
		{name: "extra segment", path: "/v1/conversations/abc/extra/messages", ok: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			id, ok := conversationID(httptest.NewRequest(http.MethodGet, test.path, nil))
			if id != test.want || ok != test.ok {
				t.Fatalf("conversationID(%q) = %q, %t; want %q, %t", test.path, id, ok, test.want, test.ok)
			}
		})
	}
}

func TestConversationRoutesRejectMalformedGETAndPOST(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		t.Run(method, func(t *testing.T) {
			request := httptest.NewRequest(method, "/v1/conversations/abc/extra/messages", strings.NewReader(`{"text":"hello","idempotencyKey":"key"}`))
			request.Header.Set("Authorization", "Bearer test-token")
			recorder := httptest.NewRecorder()

			newTestServer().ServeHTTP(recorder, request)

			if recorder.Code != http.StatusNotFound {
				t.Fatalf("expected malformed %s route to return 404, got %d", method, recorder.Code)
			}
		})
	}
}

func TestSendRejectsMalformedInput(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/v1/conversations/demo/messages", strings.NewReader("{}"))
	request.Header.Set("Authorization", "Bearer test-token")
	recorder := httptest.NewRecorder()

	newTestServer().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected bad request status 400, got %d", recorder.Code)
	}
}

func TestProviderMessageIDIsStable(t *testing.T) {
	first := providerMessageID("conversation", "key")
	second := providerMessageID("conversation", "key")
	other := providerMessageID("conversation", "other-key")
	if first != second {
		t.Fatalf("expected stable provider ID, got %q and %q", first, second)
	}
	if first == other {
		t.Fatalf("expected different idempotency keys to produce different IDs")
	}
}

func TestSessionEncryptionRoundTrip(t *testing.T) {
	key := make([]byte, 32)
	encodedKey := base64.RawStdEncoding.EncodeToString(key)
	original := libgm.NewAuthData()
	original.TachyonTTL = 42
	ciphertext, err := encryptSession(original, encodedKey)
	if err != nil {
		t.Fatalf("encrypt session: %v", err)
	}
	restored, err := decryptSession(ciphertext, encodedKey)
	if err != nil {
		t.Fatalf("decrypt session: %v", err)
	}
	if restored.TachyonTTL != original.TachyonTTL {
		t.Fatalf("expected restored session TTL %d, got %d", original.TachyonTTL, restored.TachyonTTL)
	}
	if ciphertext == "" {
		t.Fatal("expected ciphertext")
	}
}

func TestSessionDecryptionRejectsTampering(t *testing.T) {
	key := base64.RawStdEncoding.EncodeToString(make([]byte, 32))
	ciphertext, err := encryptSession(libgm.NewAuthData(), key)
	if err != nil {
		t.Fatalf("encrypt session: %v", err)
	}
	sealed, err := base64.RawURLEncoding.DecodeString(ciphertext)
	if err != nil || len(sealed) < 2 {
		t.Fatal("expected ciphertext")
	}
	sealed[len(sealed)-1] ^= 1
	tampered := base64.RawURLEncoding.EncodeToString(sealed)
	if _, err := decryptSession(tampered, key); err == nil {
		t.Fatal("expected tampered ciphertext to be rejected")
	}
}

func TestSessionKeyMustBeBase64Encoded32Bytes(t *testing.T) {
	valid := base64.RawStdEncoding.EncodeToString(make([]byte, 32))
	if _, err := decodeSessionKey(valid); err != nil {
		t.Fatalf("expected valid session key: %v", err)
	}
	for _, invalid := range []string{"", "not-base64", base64.RawStdEncoding.EncodeToString(make([]byte, 31))} {
		if _, err := decodeSessionKey(invalid); err == nil {
			t.Fatalf("expected invalid session key %q to be rejected", invalid)
		}
	}
}

func bodyContainsSecret(body string) bool {
	return body == "test-token" || body == "" || len(body) > 256
}

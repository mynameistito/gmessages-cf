package main

import (
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rs/zerolog"
	"go.mau.fi/mautrix-gmessages/pkg/libgm"
	"go.mau.fi/mautrix-gmessages/pkg/libgm/events"
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

func TestProtectedEndpointsRequireInternalToken(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/v1/conversations", nil)
	recorder := httptest.NewRecorder()

	newTestServer().ServeHTTP(recorder, request)

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected unauthorized status 401, got %d", recorder.Code)
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
	if len(ciphertext) < 2 {
		t.Fatal("expected ciphertext")
	}
	if _, err := decryptSession(ciphertext[:len(ciphertext)-1]+"x", key); err == nil {
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

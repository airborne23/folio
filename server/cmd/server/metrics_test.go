package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/airborne23/folio/server/internal/analytics"
	"github.com/airborne23/folio/server/internal/events"
	"github.com/airborne23/folio/server/internal/realtime"
)

func TestMainRouterDoesNotExposePrometheusMetrics(t *testing.T) {
	router := NewRouter(nil, realtime.NewHub(), events.New(), analytics.NoopClient{}, nil)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("main API /metrics status = %d, want %d", rec.Code, http.StatusNotFound)
	}
}

package research

import (
	"strings"
	"testing"
)

func TestNewCitationFixtures(t *testing.T) {
	tests := []struct {
		name                   string
		runID, claim, sourceID string
		verdict, reason        string
		want                   Citation
	}{
		{
			name:     "supported",
			runID:    " run-1 ",
			claim:    " The endpoint enforces TLS. ",
			sourceID: " source-1 ",
			verdict:  " supported ",
			reason:   " The source says TLS is mandatory. ",
			want: Citation{
				RunID:    "run-1",
				Claim:    "The endpoint enforces TLS.",
				SourceID: "source-1",
				Verdict:  CitationSupported,
				Reason:   "The source says TLS is mandatory.",
			},
		},
		{
			name:     "unsupported",
			runID:    "run-2",
			claim:    "The endpoint permits plaintext.",
			sourceID: "source-2",
			verdict:  CitationUnsupported,
			reason:   "The cited source documents TLS-only access.",
			want: Citation{
				RunID:    "run-2",
				Claim:    "The endpoint permits plaintext.",
				SourceID: "source-2",
				Verdict:  CitationUnsupported,
				Reason:   "The cited source documents TLS-only access.",
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := NewCitation(test.runID, test.claim, test.sourceID, test.verdict, test.reason)
			if err != nil {
				t.Fatalf("NewCitation() error = %v", err)
			}
			if got != test.want {
				t.Errorf("NewCitation() = %#v, want %#v", got, test.want)
			}
		})
	}
}

func TestNewCitationRejectsInvalidInput(t *testing.T) {
	tests := []struct {
		name                   string
		runID, claim, sourceID string
		verdict, reason        string
	}{
		{name: "missing run ID", runID: " \t", claim: "claim", sourceID: "source", verdict: CitationSupported},
		{name: "missing claim", runID: "run", claim: " \n ", sourceID: "source", verdict: CitationSupported},
		{name: "missing source ID", runID: "run", claim: "claim", sourceID: " ", verdict: CitationSupported},
		{name: "invalid verdict", runID: "run", claim: "claim", sourceID: "source", verdict: "uncertain"},
		{name: "claim too long", runID: "run", claim: strings.Repeat("界", 2001), sourceID: "source", verdict: CitationSupported},
		{name: "reason too long", runID: "run", claim: "claim", sourceID: "source", verdict: CitationSupported, reason: strings.Repeat("界", 1201)},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := NewCitation(test.runID, test.claim, test.sourceID, test.verdict, test.reason)
			if err == nil {
				t.Fatal("NewCitation() error = nil, want validation error")
			}
			if got != (Citation{}) {
				t.Errorf("NewCitation() = %#v on error, want zero Citation", got)
			}
		})
	}
}

func TestNewCitationUsesUnicodeCodePointLimits(t *testing.T) {
	claim := strings.Repeat("界", 2000)
	reason := strings.Repeat("界", 1200)

	got, err := NewCitation("run", claim, "source", CitationSupported, reason)
	if err != nil {
		t.Fatalf("NewCitation() error = %v", err)
	}
	if got.Claim != claim || got.Reason != reason {
		t.Errorf("NewCitation() claim/reason lengths were not preserved at their limits")
	}
}

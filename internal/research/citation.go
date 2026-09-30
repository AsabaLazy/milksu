package research

import (
	"errors"
	"strings"
	"unicode/utf8"
)

const (
	maxCitationClaimCodePoints  = 2000
	maxCitationReasonCodePoints = 1200
)

// NewCitation validates the Pi model's recorded judgement; it does not itself infer semantic support from text.
func NewCitation(runID, claim, sourceID, verdict, reason string) (Citation, error) {
	runID = strings.TrimSpace(runID)
	claim = strings.TrimSpace(sanitizeResearchText(claim))
	sourceID = strings.TrimSpace(sourceID)
	verdict = strings.TrimSpace(verdict)
	reason = strings.TrimSpace(sanitizeResearchText(reason))

	if runID == "" {
		return Citation{}, errors.New("run ID is required")
	}
	if claim == "" {
		return Citation{}, errors.New("claim is required")
	}
	if sourceID == "" {
		return Citation{}, errors.New("source ID is required")
	}
	if verdict != CitationSupported && verdict != CitationUnsupported {
		return Citation{}, errors.New("verdict must be supported or unsupported")
	}
	if utf8.RuneCountInString(claim) > maxCitationClaimCodePoints {
		return Citation{}, errors.New("claim exceeds 2000 Unicode code points")
	}
	if utf8.RuneCountInString(reason) > maxCitationReasonCodePoints {
		return Citation{}, errors.New("reason exceeds 1200 Unicode code points")
	}

	return Citation{
		RunID:    runID,
		Claim:    claim,
		SourceID: sourceID,
		Verdict:  verdict,
		Reason:   reason,
	}, nil
}

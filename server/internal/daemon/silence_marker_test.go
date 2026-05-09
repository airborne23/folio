package daemon

import "testing"

// TestIsChannelSilenceMarker pins the post-processor that catches an LLM
// disobeying the "produce no output" silence rule. Coverage split:
//
//   - exact short markers: cheap, unambiguous; classic "Silence." case
//   - paragraph markers: agent narrating its decision in a few sentences
//   - real replies that happen to start with the word "Silence": MUST NOT match
//   - real replies of any length: must pass through unchanged
//
// Add new cases here when a fresh false negative shows up in production
// (we'd rather over-document the patterns than rediscover them).
func TestIsChannelSilenceMarker(t *testing.T) {
	cases := []struct {
		name string
		out  string
		want bool
	}{
		// ---- Exact short markers ----
		{"empty", "", true},
		{"whitespace_only", "   \n\t  ", true},
		{"silence_period", "Silence.", true},
		{"silence_lowercase", "silence", true},
		{"silence_with_quotes", "\"Silence\"", true},
		{"silence_with_markdown", "*Silence*", true},
		{"silence_no_period", "Silence", true},
		{"no_reply_paren", "(no reply)", true},
		{"silent_brackets", "[silent]", true},
		{"no_reply_needed", "no reply needed", true},
		{"not_addressed_to_me", "This is not addressed to me", true},
		{"i_do_not_need_to_reply", "I do not need to reply", true},
		{"nothing_to_add", "Nothing to add", true},

		// ---- Paragraph markers (narrating the decision) ----
		{
			"narration_with_silence_dot",
			"The most recent message explicitly mentions @coordinator, not me. Silence.",
			true,
		},
		{
			"narration_already_answered",
			"I already introduced myself in the earlier thread. This is a duplicate ask. Silence.",
			true,
		},
		{
			"this_isnt_for_me_short",
			"This isn't for me — staying silent.",
			true,
		},

		// ---- Real replies that should NOT be filtered ----
		{
			"real_introduction",
			"Hi, I'm the architect. I focus on system design and the trade-offs between approaches before code lands.",
			false,
		},
		{
			"real_reply_starts_with_silence_word",
			"Silence is golden, but here's the answer: the bug was in the cache invalidation path. Fixed in commit abc123. Let me know if you want a deeper write-up of the root cause.",
			false,
		},
		{
			"long_paragraph_mentioning_silence",
			"I looked into this. The original silence-rule was added in 2026-04 to dampen agent-to-agent loops on sign-off mentions. We'd need to broaden it to also handle duplicate requests, which means tracking seen-prompts per channel — not a one-line change.",
			false,
		},
		{
			"long_useful_reply",
			"The repo has three layers: cmd/server is the entry point, internal/handler holds the routing-level glue, and internal/agent is where the channel dispatcher lives. The dispatcher decides which agents to wake on each new message based on subscribe_mode and mention parsing.",
			false,
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			if got := isChannelSilenceMarker(tc.out); got != tc.want {
				t.Fatalf("isChannelSilenceMarker(%q) = %v, want %v", tc.out, got, tc.want)
			}
		})
	}
}

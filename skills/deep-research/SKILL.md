---
name: deep-research
description: Use for scoped deep-research questions that need multiple sources and a source-backed synthesis. Same-turn Pi subagent overlap is unconfirmed; claim concurrency only when observed.
---

# Deep Research

Answer a bounded question using evidence returned by the current research tools. Preserve the user's scope and make source quality, uncertainty, and synthesis visible.

## Scope the query

- Reduce the request to one canonical query that states the question, relevant subject, time range or as-of date, jurisdiction or population when applicable, and exclusions. Keep this query consistent across the parent and every lane.
- Do not broaden the request to adjacent topics. If an ambiguity would materially change the answer, ask one clarifying question or state a narrow assumption before researching.
- For changing facts, record the as-of date and distinguish current evidence from historical evidence.

## Choose lanes

- Use one lane for a simple, well-bounded question that can be answered from one coherent evidence stream.
- Use 2-4 independent lanes only when the question justifies distinct evidence streams or subquestions. Default to 3; never exceed 4. Keep each lane non-overlapping and give each the same canonical query plus its own narrow focus.
- Use only bundled roles currently offered by the `subagent` tool. Prefer a listed read-only research role such as `scout`, `researcher`, or `evidence-auditor` when available; never invent a role or use a user/project agent.
- Ask each lane for concise findings with exact source titles, URLs returned by tools, dates, supporting evidence, and unresolved uncertainty. A child result is evidence to assess, not a conclusion to adopt automatically.

## Launch and wait

- The Pi contract accepts one subagent launch per call. Send each launch as its own single `{ agent, task }` call. Never pass `tasks`, `parallel`, or `chain` arrays, and never ask a child to launch another child.
- When independent lanes merit overlap, issue their separate single-launch calls in one parent response only as an attempt to overlap them. Same-turn Pi concurrency is unconfirmed locally. Do not claim parallel execution unless the observed harness behavior shows the calls actually overlapped; otherwise describe only the separate calls.
- Wait for every call in the batch to return before synthesizing. If a result is still pending, use the supported status operation and continue waiting rather than presenting a partial batch as complete.
- After reviewing the first batch, allow at most one gap-fill batch, only for a material unanswered or conflicting point. Keep its tasks narrow, wait for all its results, and then synthesize. If a gap remains, report it instead of starting another batch.
- Use as many `web_search` and `web_fetch` calls as the evidence requires; there is no fixed call-count quota.

## Gather and assess evidence

- Prefer primary and official sources: original studies or data, laws and regulations, official documentation, standards, and maintainer or agency statements. Use secondary sources to add context or when primary evidence is unavailable.
- Use `web_search` to discover sources. Fetch only URLs returned by `web_search` with `web_fetch`, and prefer reading the source over relying on a search snippet.
- Use only tools actually exposed in each session. Ask each lane to use `web_search`/`web_fetch` when available. A lane without them must report that limitation and any source leads; the parent verifies those leads with its own search/fetch tools before citing.
- Compare dates, scope, definitions, methods, and provenance across sources. Separate direct evidence from interpretation, and preserve unresolved disagreements or limitations.
- Cite only URLs and claims actually returned by tools. Put citations beside the claims they support; do not invent URLs, cite from memory, or imply a source supports more than its returned content establishes.

## Synthesize

- Lead with a direct answer to the canonical query, then organize the strongest findings and their evidence. Keep the answer proportional to the question.
- Distinguish verified claims, inference, and remaining uncertainty. Note important source limits and the as-of date for time-sensitive conclusions.
- Make the parent synthesis itself: reconcile lane results, remove duplicates, resolve contradictions where evidence allows, and state what remains unresolved. Do not present lane count or delegated work as proof of completeness.

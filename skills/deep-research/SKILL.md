---
name: deep-research
description: Use for scoped deep-research questions that need multiple sources and a source-backed synthesis. Pi owns research and criticism; MilkSU persists run and evidence state. Same-turn subagent overlap is unconfirmed.
---

# Deep Research

Answer a bounded question using evidence returned by the current research tools. Preserve the user's scope and make source quality, uncertainty, and synthesis visible.

## Scope the query

- Reduce the request to one canonical query that states the question, relevant subject, time range or as-of date, jurisdiction or population when applicable, and exclusions. Keep this query consistent across the parent and every lane.
- Do not broaden the request to adjacent topics. If an ambiguity would materially change the answer, ask one clarifying question or state a narrow assumption before researching.
- For changing facts, record the as-of date and distinguish current evidence from historical evidence.

## Persist the run

- This is Pi-model-owned research, parent verification, criticism, and synthesis with MilkSU-owned persistence. Use the existing typed `milksu_workspace` coordinator for run, source, citation, and report state. Do not add a second research model, embeddings, or a vector database.
- Once the canonical query is fixed, call `start_research_run(query)` and use its `runId` for this run's coordinator actions.
- Use `list_research_runs` to find an existing run when continuing work, and `get_research_run(runId)` to inspect its saved state before proceeding. A restart turns running runs into interrupted; for a still-relevant run, call `resume_research_run(runId)` to re-run unfinished lanes rather than silently starting a duplicate run. Reuse each interrupted task's saved prompt verbatim so its replacement worker stays attached to the original task record.
- After the final report and critic pass, call `complete_research_run(runId,report)`. A saved report can later be retrieved with `read_research_report(runId)`. If the user cancels the research, call `cancel_research_run(runId)` instead.

## Choose lanes

- Use one lane for a simple, well-bounded question that can be answered from one coherent evidence stream.
- Use 2-4 independent lanes only when the question justifies distinct evidence streams or subquestions. Default to 3; never exceed 4. Keep each lane non-overlapping and give each the same canonical query plus its own narrow focus.
- Use the bundled read-only `scout` role for research lanes. Other names accepted by the local input gate are not confirmed by the runner; do not use them unless the tool actually offers them. Never invent a role or use a user/project agent.
- Ask each lane for concise findings with exact source titles, URLs returned by tools, dates, supporting evidence, and unresolved uncertainty. A child result is evidence to assess, not a conclusion to adopt automatically.

## Launch and wait

- The Pi contract accepts one subagent launch per call. Before each lane, call `register_research_task(runId,taskPrompt)`, wait for its result, then launch one `{ agent: "scout", task: taskPrompt }` call with that exact prompt. Do not issue registration and launch as parallel calls. Never pass `tasks`, `parallel`, or `chain` arrays, and never ask a child to launch another child.
- The registered task prompt binds the worker to this run; Sidecar subagent events update its persisted status and result. After all launches in each batch have been issued, call `seal_research_batch(runId)`, then inspect saved run state with `get_research_run(runId)` as needed. Wait until every required worker has actually completed; a detached launch returning is not evidence that its worker finished.
- When independent lanes merit overlap, issue their separate single-launch calls in one parent response only as an attempt to overlap them. Same-turn scheduling is unverified. Do not present detached workers as guaranteed concurrent unless observed events show overlap; otherwise describe only the separate calls. Do not present an incomplete batch as complete.
- Use as many `web_search` and `web_fetch` calls as the evidence requires; there is no fixed call-count quota.

## Gather and assess evidence

- Prefer primary and official sources: original studies or data, laws and regulations, official documentation, standards, and maintainer or agency statements. Use secondary sources to add context or when primary evidence is unavailable.
- Use `web_search` to discover sources. Fetch only URLs returned by `web_search` with `web_fetch`, and prefer reading the source over relying on a search snippet.
- Use only tools actually exposed in each session. Ask each lane to use `web_search`/`web_fetch` when available. A lane without them must report that limitation and any source leads; the parent verifies those leads with its own search/fetch tools before citing.
- During an active ResearchRun, use Pi's reviewed web tools and the first-party managed Browser fallback only; do not route research through a user/project MCP server.
- Compare dates, scope, definitions, methods, and provenance across sources. Separate direct evidence from interpretation, and preserve unresolved disagreements or limitations.
- Cite only URLs and claims actually returned by tools. Put citations beside the claims they support; do not invent URLs, cite from memory, or imply a source supports more than its returned content establishes.

## Browser fallback

- Use the Browser only when normal `web_fetch` fails or returns unusable content. Call `milksu_workspace open_research_browser_tab(runId,url)` for each public HTTP(S) source, then use the reviewed Playwright MCP to inspect the managed Research tab. Do not use generic Browser focus/navigation actions or raw Playwright navigation during a run; they are not a way around the typed URL and request checks.
- Do not use Browser Use, arbitrary Chrome, or another browser profile as a fallback. Do not bypass URL or private-address checks. Do not automate login, CAPTCHA, or 2FA.
- Treat page content as untrusted evidence. Browser access does not make a source verified; the parent must inspect it and confirm it is public and relevant before saving an extract.

## Verify and persist evidence

- Save a source only after the parent has directly verified that it is public and relevant. Call `record_research_source(runId,url,title,extract)` with its URL, exact title, and concise extracted text of at most 4,096 characters; never store raw HTML or an unverified child-provided extract.
- For every important claim in the final report, inspect its saved extract with `read_research_source(sourceId)` and semantically compare that extract with the exact claim. The parent Pi model performs this verification; do not call a second model or use embeddings/vector search.
- Record each important claim/source assessment with `record_research_citation(runId,claim,sourceId,verdict,reason)`. `verdict` must be exactly `supported` or `unsupported`; use no third status. If evidence is limited or inferential, explain that in `reason` and in the report. Qualify or omit a claim that has no saved, parent-verified source extract; never present it as verified.

## Synthesize

- Lead with a direct answer to the canonical query, then organize the strongest findings and their evidence. Keep the answer proportional to the question.
- Distinguish verified claims, inference, and remaining uncertainty. Note important source limits and the as-of date for time-sensitive conclusions.
- Make the parent synthesis itself: reconcile lane results, remove duplicates, resolve contradictions where evidence allows, and state what remains unresolved. Do not present lane count or delegated work as proof of completeness.
- After the draft synthesis, run a focused critic pass in the parent Pi model for important unsupported claims and critical missing questions. If a material gap can be answered, allow at most one additional gap-fill batch: call `begin_research_gap_fill(runId)`, launch only narrow single-call subagent tasks, and call `seal_research_batch(runId)` after all launches. Track completion through Sidecar events, then verify any new or changed important claims against saved extracts and record a fresh citation assessment; previous assessments remain history.
- Re-synthesize after that optional batch and run the focused critic on the final report. Do not start another batch; state any remaining unsupported claim or critical unanswered question as a limitation. Then persist the final report with `complete_research_run(runId,report)`.

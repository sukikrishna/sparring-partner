# Design notes

## Principles

1. **Separate human and AI space.** The negotiator's own strategy lives in a
   column the AI never writes to. AI output lives in its own column, always
   labelled with where it came from.
2. **Ask, don't tell.** Flagged passages come with a question rather than a
   verdict. AI-framed questioning has been shown to improve people's ability to
   spot flawed reasoning (Danry et al., 2023, *Don't Just Tell Me, Ask Me*).
3. **Ground everything in the case.** Every AI claim cites a document and
   paragraph; answers say so when the documents are silent or one-sided.
4. **Go down rabbit holes without polluting context.** Each document gets its
   own chat, aware of the overall strategy but isolated from other chats.

## Version 1 (`prototypes/v1/`)

A single static page with a fictional procurement case. Three columns:
AI-Synthesis, Human-Only, Source Documents. The strategy text was pre-written
with three highlighted flaws; clicking a highlight opened one source document
and a scripted chat; key findings from the chat were added under that flaw's
tab on the synthesis side. Editing a highlighted passage enough cleared it.

## Version 2: what changed and why

### Feedback that shaped this version

- *The AI-Synthesis column should be more free-flow.* Users should be able to
  keep general notes, comments and ideas there, not only findings tied to a
  flagged passage. That raises the question of where non-gap AI insights come
  from, since in v1 every insight came from a gap's document chat.
- *The Human-Only column looked too polished.* With real users it will hold
  rough, free-flow thinking. The AI side could then present that thinking in a
  more useful format that uses negotiation concepts.

### Responses

**Free-flow synthesis board.** The board now holds three kinds of cards, each
labelled: findings from document chats, findings from a new case-wide chat, and
the negotiator's own notes. Cards are filed under a gap or under *General*, and
can be moved. Findings are saved automatically or only on request.

**New sources of general insight.**
- *Library:* every document the role can see is browsable, each with its own
  chat, independent of any gap.
- *Ask all documents:* a case-wide chat that retrieves passages from every
  visible document and cites them.
- *Your notes:* typed directly on the board, marked as human.

**Free-flow notes, structured on demand.** The Human-Only column now starts
with rough notes (lower case, fragments, half-formed plans) and nothing is
highlighted until the user asks for a check. A *Structured view* tab restates
the notes in negotiation-framework terms:

- the *iceberg* (position, interests, values) for each party,
- the *island of agreement* (convergent and contested facts, shared and
  divergent norms),
- stakeholders, red lines, alternatives to agreement, options,
- open questions the framework raises that the notes do not answer.

The structurer may reorganise but not add substance: every item links to the
phrase in the notes it restates (click to select it in the editor), to a saved
insight, or is marked as a framework question. Gaps in the user's thinking
show up as empty sections and open questions rather than AI-supplied answers.

**Real cases and documents.** v2 runs on the course simulation cases, ingested
from their original files, with role-specific document sets.

**Gap lifecycle.** Gaps can be resolved by editing (re-checked on *Submit
changes*; in live mode a model judges whether the revision still rests on the
assumption), dismissed by the user, or reopened.

**Infrastructure.** A Python backend with Claude-powered agents, offline
fallbacks, an information barrier between roles, session export and an
interaction log for studies, tests and CI.

## Open questions

- **Argument map.** Visualising the strategy as an argument map (with
  counterarguments attached to specific claims) could complement the text view;
  it needs more screen space and probably its own window.
- **Devil's advocate.** Should the system generate counterarguments
  deliberately, even where documents are silent? That trades grounding for
  coverage.
- **Automatic vs manual saving.** Which default leads to better understanding
  and less over-reliance? The setting and event log make this testable.
- **Updating structure from chats.** When a chat changes the negotiator's mind,
  should the structured view update automatically, or only when they edit
  their own notes?
- **Rehearsal.** A simulated counterpart, constrained to the other role's
  documents, would let negotiators test a revised strategy.

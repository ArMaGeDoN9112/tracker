# Issue tracker: Local Markdown

Issues and specs live in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`.
- Spec: `.scratch/<feature-slug>/spec.md`.
- Tickets: `.scratch/<feature-slug>/issues/<NN>-<slug>.md`,
  numbered from 01, one file per ticket.
- Record triage state in a `Status:` line near the top;
  use the values in `triage-labels.md`.
- Append conversation under `## Comments`.

When publishing, create the corresponding file and directory.
When fetching a ticket, read its referenced file.

## Wayfinding operations

- Map: `.scratch/<effort>/map.md`, containing Notes,
  Decisions-so-far, and Fog.
- Child tickets: `.scratch/<effort>/issues/NN-<slug>.md`.
- Record ticket type in `Type:`:
  research, prototype, grilling, or task.
- Record dependencies in `Blocked by: NN, NN`.
- A ticket is unblocked when all dependencies are resolved.
- Select the first open, unblocked, unclaimed ticket by number.
- Claim: save `Status: claimed` before starting work.
- Resolve: append `## Answer`, set `Status: resolved`,
  then add a summary and link to Decisions-so-far in the map.

## Completed features

- Keep current behavior in `docs/diabetes-diary.md`, future requirements in
  `docs/roadmap.md`, and operational commands in README / `docs/backup.md`.
- Before removing a completed feature directory, move unfinished criteria to
  an active effort, update dependencies and links, and verify the old files
  are recoverable from a committed Git revision. Keep the revision reference.
- Preserve the overall interview specification and decision map in
  `.scratch/tracker/spec.md` and `.scratch/tracker/map.md`. They retain product
  context across stages; a shortened roadmap does not replace them.
- Remove feature-specific completed specs, maps, tickets and acceptance images
  after that transfer. Git history is their archive; no duplicate archive folder.

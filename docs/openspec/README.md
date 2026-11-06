# OpenSpec status

Run OpenSpec from docs/ so this existing openspec/ root is selected.

The spec-driven change [redesign-permissionless-robinhood-arena](changes/redesign-permissionless-robinhood-arena/proposal.md) is the **unimplemented target proposal**. All its implementation tasks remain unchecked.

Existing specs/ and add-war-bonds / add-verifiable-burn changes describe the legacy product. Their historical task statuses do not establish target completion. The target supersedes old swap settlement, TWAP, bonds and credit plans. Parent-folder archives remain outside this repository and are not imported or archived by this PR.

```bash
cd docs
openspec validate --all --strict --no-interactive
```

OpenSpec status may report isComplete when proposal artifacts exist. That means artifact readiness only; all redesign implementation checkboxes remain unfinished.

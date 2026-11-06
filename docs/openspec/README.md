# OpenSpec status

Run OpenSpec from docs/ so this openspec/ root is selected.

The only spec-driven change is [redesign-permissionless-robinhood-arena](changes/redesign-permissionless-robinhood-arena/proposal.md). It is the **unimplemented target**: all its implementation tasks stay unchecked until the work is delivered and verified.

```bash
cd docs
npx @fission-ai/openspec validate --all --strict --no-interactive
```

OpenSpec status may report isComplete when proposal artifacts exist. That means artifact readiness only, not implementation.

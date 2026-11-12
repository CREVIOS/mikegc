# Bangladesh workflow pack

Drafting and review workflows for Bangladeshi law and procedure. The folders
here are laid out as the system workflows repository expects
(`MIKE_WORKFLOWS_REPOSITORY`, by default
`open-legal-products/mikegc-workflows`):

```
assistant-workflows/bangladesh/pack.yaml
assistant-workflows/bangladesh/<workflow>/SKILL.md
tabular-review-workflows/bangladesh/pack.yaml
tabular-review-workflows/bangladesh/<workflow>/SKILL.md
tabular-review-workflows/bangladesh/<workflow>/table-columns.yaml
```

The workflow sync adds this pack to the catalog it downloads, so nothing needs
copying: run `npm run sync:workflows --prefix backend` (Compose runs it as
`workflow-sync`). To maintain the pack in your own workflows repository
instead, copy both `bangladesh/` folders there; that copy then wins.
`SPECTRE_WORKFLOW_PACKS=none` leaves the pack out.
`backend/src/lib/__tests__/bangladeshWorkflows.test.ts` loads this pack through
the catalog parser on every backend test run.

The workflows rely on the assistant's Laws of Bangladesh tools to check every
statute they cite. See [Spectre for Bangladesh](../../docs/bangladesh.md).

The workflows are licensed under Apache 2.0, like the system workflows
repository.

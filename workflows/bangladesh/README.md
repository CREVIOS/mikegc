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

To install them, copy both `bangladesh/` folders into the matching folders of
your workflows repository, point `MIKE_WORKFLOWS_REPOSITORY` at it, and run the
workflow sync. `backend/src/lib/__tests__/bangladeshWorkflows.test.ts` loads
this pack through the catalog parser on every backend test run.

The workflows rely on the assistant's Laws of Bangladesh tools to check every
statute they cite. See [Spectre for Bangladesh](../../docs/bangladesh.md).

The workflows are licensed under Apache 2.0, like the system workflows
repository.

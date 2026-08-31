<!--
提交前请先读一遍 CONTRIBUTING.md。较大的改动建议先开 issue 讨论方案，避免白做。
Please read CONTRIBUTING.md first. For larger changes, open an issue to agree on the approach before writing code.
-->

## 改动说明 / What changed

<!-- 做了什么、为什么这么做。请描述意图，而不是逐行复述 diff。 -->
<!-- What and why. Describe the intent, not a line-by-line restatement of the diff. -->

## 关联 issue / Related issues

<!-- 例如 / e.g. Closes #123 -->

## 改动类型 / Type of change

- [ ] Bug 修复 / Bug fix
- [ ] 新功能 / New feature
- [ ] 重构，不改变外部行为 / Refactor with no behaviour change
- [ ] 文档 / Documentation
- [ ] 构建、CI、部署 / Build, CI or deployment

## 验证 / Verification

<!-- 你实际跑了什么、手动测了什么。没跑就如实写没跑。 -->
<!-- What you actually ran and manually tested. If you did not run something, say so. -->

- [ ] `pnpm lint` 通过 / passes
- [ ] `pnpm test` 通过 / passes
- [ ] `cd web && pnpm test` 通过 / passes
- [ ] 手动验证过受影响的界面 / Manually verified the affected UI

## 检查项 / Checklist

- [ ] 改动范围收敛在本 PR 的目标内，没有夹带无关修改 / Scope is limited to this PR's goal, no unrelated changes
- [ ] 改了数据库 schema 的话，已跑 `pnpm db:generate` 并提交了 `drizzle/` 下的迁移 / Ran `pnpm db:generate` and committed the migration if the schema changed
- [ ] 改了后端接口的话，已重新生成前端 SDK（`pnpm generate:api`）/ Regenerated the frontend SDK if backend endpoints changed
- [ ] 新增 UI 文案已走 i18n，并在 `web/src/locales/zh-CN.json` 补了中文翻译 / New UI strings go through i18n and have a `zh-CN` translation
- [ ] 已同步更新受影响的 `docs/` 文档 / Updated the affected docs under `docs/`

## 补充信息 / Additional notes

<!-- 截图、录屏、已知限制、需要 reviewer 特别看的地方。 -->
<!-- Screenshots, recordings, known limitations, anything you want the reviewer to look at closely. -->
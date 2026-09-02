# AI assistant configuration

Committed so anyone cloning the repo gets the same operational knowledge, and so
it is reviewed in pull requests like any other file.

## Two mechanisms

|          | [`CLAUDE.md`](CLAUDE.md)            | [`.claude/skills/`](.claude/skills/)                 |
| -------- | ----------------------------------- | ---------------------------------------------------- |
| Loaded   | Always, every session               | Only when the task matches the skill's `description` |
| Contains | Rules that apply to _any_ change    | Procedures for _one_ area                            |
| Length   | Short — it costs context every turn | As long as the task needs                            |

The test: does this apply to every change, or only to one area? Import
conventions go in `CLAUDE.md`; Banking API curl recipes go in a skill.

## The skills

| Skill                                                    | Loads when you are…                                                                                            |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [`banking-api`](.claude/skills/banking-api/SKILL.md)     | Integrating or debugging the upstream client — auth, pagination, the categories dictionary, capturing fixtures |
| [`scoring-model`](.claude/skills/scoring-model/SKILL.md) | Touching the Reliability Index — components, constants, purity rules, writing drivers                          |
| [`run-service`](.claude/skills/run-service/SKILL.md)     | Starting or smoke-testing the app — first run, curl checks, startup failures                                   |

They map to the three ways this codebase goes wrong: wrong data in, an
indefensible score, or not being able to run it at all.

## Adding one

Create `.claude/skills/<kebab-name>/SKILL.md` with `name` and `description`
frontmatter, then add a row above. Write the `description` for retrieval — it is
the only part read until the skill loads, so it should contain the words someone
would use when they need it.

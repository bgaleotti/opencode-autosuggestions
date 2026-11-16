import type { SessionMessageInfo } from "@opencode/client"

// Conversations for comparing prompt versions. Each case says what a good suggestion looks like (`good`), for the
// person reading the results, and optionally a pattern a good suggestion must not match (`avoid`).

export type Language = "en" | "es"

export interface FollowUpCase {
  readonly id: string
  readonly language: Language
  readonly messages: readonly SessionMessageInfo[]
  readonly good: string
  readonly avoid?: RegExp
}

export interface CompletionCase {
  readonly id: string
  readonly language: Language
  readonly messages: readonly SessionMessageInfo[]
  readonly unfinished: string
  readonly good: string
  readonly avoid?: RegExp
}

let next = 0
const id = () => `m${next++}`

const user = (text: string) => ({ type: "user", id: id(), time: { created: 0 }, text }) as SessionMessageInfo

type Tool = { name: string; input: Record<string, string> }
const read = (path: string): Tool => ({ name: "read", input: { path } })
const edit = (path: string): Tool => ({ name: "edit", input: { path, oldString: "…", newString: "…" } })
const write = (path: string): Tool => ({ name: "write", input: { path, content: "…" } })
const shell = (command: string): Tool => ({ name: "shell", input: { command } })

const assistant = (text: string, tools: Tool[] = []) =>
  ({
    type: "assistant",
    id: id(),
    time: { created: 0 },
    agent: "build",
    model: { providerID: "anthropic", id: "claude-opus-5-5" },
    content: [
      ...tools.map((tool) => ({
        type: "tool",
        id: id(),
        name: tool.name,
        state: { status: "completed", input: tool.input, content: [{ type: "text", text: "…" }] },
        time: { created: 0 },
      })),
      { type: "text", text },
    ],
  }) as SessionMessageInfo

export const followUpCases: readonly FollowUpCase[] = [
  {
    id: "offer-tests",
    language: "en",
    messages: [
      user("add a slugify helper to src/utils/strings.ts"),
      assistant("Added `slugify` to `src/utils/strings.ts`. Want me to add unit tests for it?", [
        read("src/utils/strings.ts"),
        edit("src/utils/strings.ts"),
      ]),
    ],
    good: "Accepts the offer: yes, add tests (ideally for slugify).",
  },
  {
    id: "tests-pass",
    language: "en",
    messages: [
      user("fix the off-by-one in paginate()"),
      assistant(
        "Fixed the off-by-one in `paginate()` in `src/api/pagination.ts`: the last page was skipped. All 42 tests pass.",
        [read("src/api/pagination.ts"), edit("src/api/pagination.ts"), shell("npm test")],
      ),
    ],
    good: "A natural next step: commit it, or add a regression test for the last page.",
    avoid: /run (the )?tests/i,
  },
  {
    id: "tests-fail",
    language: "en",
    messages: [
      user("rename getUser to fetchUser everywhere"),
      assistant(
        "Renamed `getUser` to `fetchUser` in 6 files. One test fails: `profile.test.ts` still mocks `getUser`.",
        [edit("src/users.ts"), edit("src/profile.ts"), shell("npm test")],
      ),
    ],
    good: "Fix the failing test: update the mock in profile.test.ts.",
  },
  {
    id: "choice-question",
    language: "en",
    messages: [
      user("we need caching for the products endpoint"),
      assistant(
        "Two options: an in-memory LRU cache (simple, per instance) or Redis (shared across instances, needs infra). Which do you prefer?",
        [read("src/routes/products.ts")],
      ),
    ],
    good: "Picks one of the two options, short.",
  },
  {
    id: "explanation-only",
    language: "en",
    messages: [
      user("how does the auth middleware work?"),
      assistant(
        "`src/middleware/auth.ts` reads the bearer token, verifies it with `jwt.verify`, and attaches `req.user`. Expired tokens return 401; there is no refresh logic.",
        [read("src/middleware/auth.ts")],
      ),
    ],
    good: "A follow-up about what was explained, e.g. add refresh token handling.",
  },
  {
    id: "plan-approval",
    language: "en",
    messages: [
      user("migrate the config loader from yaml to toml"),
      assistant(
        "Plan:\n1. Add `smol-toml`.\n2. Rewrite `src/config/load.ts` to parse TOML.\n3. Convert `config.yaml` to `config.toml`.\nShould I go ahead?",
        [read("src/config/load.ts"), read("config.yaml")],
      ),
    ],
    good: "Approves the plan: go ahead.",
  },
  {
    id: "declined",
    language: "en",
    messages: [
      user("deploy it to production"),
      assistant(
        "I can't deploy from here: there are no production credentials in this environment. The deploy script is `scripts/deploy.sh`.",
      ),
    ],
    good: "Does not ask to deploy again; e.g. asks how to run it, or moves on.",
    avoid: /(run|do|try) (the )?deploy|deploy (it|this|again|to prod)/i,
  },
  {
    id: "no-tests-project",
    language: "en",
    messages: [
      user("add a /health endpoint"),
      assistant('Added `GET /health` in `app.py`, returning `{"status": "ok"}`.', [read("app.py"), edit("app.py")]),
    ],
    good: "Something concrete about the endpoint (add a test, check the DB, commit). Not just 'thanks'.",
    avoid: /^(ok|thanks|thank you|great)[.!]*$/i,
  },
  {
    id: "casual-style",
    language: "en",
    messages: [
      user("yo can u make the navbar sticky"),
      assistant("Made the navbar sticky with `position: sticky; top: 0` in `src/components/Navbar.css`.", [
        edit("src/components/Navbar.css"),
      ]),
      user("nice, also add a shadow when scrolling"),
      assistant("Added a shadow that appears after scrolling 8px, using an IntersectionObserver in `Navbar.tsx`.", [
        edit("src/components/Navbar.tsx"),
      ]),
    ],
    good: "Lowercase, casual, like the user. Something about the navbar.",
  },
  {
    id: "es-offer-tests",
    language: "es",
    messages: [
      user("agregá validación al form de registro"),
      assistant(
        "Agregué validación con zod en `src/forms/signup.ts`: email válido y contraseña de al menos 8 caracteres. ¿Querés que agregue tests?",
        [edit("src/forms/signup.ts")],
      ),
    ],
    good: "In Spanish, accepting: sí, agregá los tests.",
  },
  {
    id: "es-fix-proposal",
    language: "es",
    messages: [
      user("por qué falla el login en safari?"),
      assistant(
        "Safari bloquea la cookie de sesión porque no tiene `SameSite=None; Secure`. Se arregla en `src/server/session.ts`. ¿Lo cambio?",
        [read("src/server/session.ts")],
      ),
    ],
    good: "In Spanish, approving the fix: dale, cambialo.",
  },
  {
    id: "es-pr",
    language: "es",
    messages: [
      user("escribí la descripción del PR para este cambio"),
      assistant("Listo, dejé la descripción en `PR.md`: resumen, cambios y cómo probarlo.", [write("PR.md")]),
    ],
    good: "In Spanish, next step: abrí el PR / subilo.",
  },
  {
    id: "es-missing-env",
    language: "es",
    messages: [
      user("corré el build"),
      assistant("El build falla: falta la variable `DATABASE_URL` en `.env`. El resto compila bien.", [
        shell("npm run build"),
      ]),
    ],
    good: "In Spanish, about the missing variable (e.g. agregala con un valor de ejemplo).",
  },
  {
    id: "es-spanglish",
    language: "es",
    messages: [
      user("hacé un refactor del hook useCart para que use un reducer"),
      assistant("Pasé `useCart` a `useReducer` en `src/hooks/useCart.ts`, con acciones add, remove y clear.", [
        edit("src/hooks/useCart.ts"),
      ]),
    ],
    good: "In Spanish with English tech terms, like the user.",
  },
]

export const completionCases: readonly CompletionCase[] = [
  {
    id: "mid-word",
    language: "en",
    messages: [],
    unfinished: "add a health check endp",
    good: "Finishes 'endpoint' and maybe a short purpose.",
  },
  {
    id: "after-word",
    language: "en",
    messages: [],
    unfinished: "add a health check endpoint that",
    good: "What it returns or checks.",
  },
  {
    id: "context-file",
    language: "en",
    messages: [
      user("add a slugify helper"),
      assistant("Added `slugify` to `src/utils/strings.ts`.", [edit("src/utils/strings.ts")]),
    ],
    unfinished: "now add tests for",
    good: "Mentions slugify or strings.ts.",
  },
  {
    id: "failing-test",
    language: "en",
    messages: [
      user("rename getUser to fetchUser"),
      assistant("Renamed it in 6 files. `profile.test.ts` still mocks `getUser` and fails.", [shell("npm test")]),
    ],
    unfinished: "update the mock in",
    good: "profile.test.ts, to fetchUser.",
  },
  {
    id: "package-name",
    language: "en",
    messages: [],
    unfinished: "sure but use pyt",
    good: "pytest.",
  },
  {
    id: "why",
    language: "en",
    messages: [
      user("clean up the config loader"),
      assistant("Simplified `src/config/load.ts` and removed the YAML fallback.", [edit("src/config/load.ts")]),
    ],
    unfinished: "why did you remove the",
    good: "YAML fallback.",
  },
  {
    id: "complete-already",
    language: "en",
    messages: [user("should I add tests?"), assistant("Want me to add unit tests for slugify?")],
    unfinished: "yes, do it",
    good: "Nothing, or a very short natural addition.",
  },
  {
    id: "es-mid-word",
    language: "es",
    messages: [],
    unfinished: "agregá un test que verif",
    good: "verifique + something, in Spanish.",
  },
  {
    id: "es-context",
    language: "es",
    messages: [
      user("agregá validación al form de registro"),
      assistant("Agregué validación con zod en `src/forms/signup.ts`.", [edit("src/forms/signup.ts")]),
    ],
    unfinished: "dale, pero también validá que",
    good: "Something about the signup form fields, in Spanish.",
  },
  {
    id: "es-alternative",
    language: "es",
    messages: [
      user("necesito cache para productos"),
      assistant("Puedo usar un LRU en memoria o Redis. ¿Cuál preferís?"),
    ],
    unfinished: "no, mejor usá",
    good: "Redis or LRU, in Spanish.",
  },
  {
    id: "es-error",
    language: "es",
    messages: [
      user("corré el build"),
      assistant("El build falla: falta `DATABASE_URL` en `.env`.", [shell("npm run build")]),
    ],
    unfinished: "agregá la variable",
    good: "DATABASE_URL al .env, in Spanish.",
  },
  {
    id: "es-explain",
    language: "es",
    messages: [],
    unfinished: "explicame cómo funciona el",
    good: "Something plausible, in Spanish. Hard without context.",
  },
]

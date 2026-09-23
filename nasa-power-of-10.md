# NASA JPL — Power of 10: Rules for Safety-Critical Code

**Author**: Gerard J. Holzmann, NASA/JPL Laboratory for Reliable Software (2006)
**Source**: https://spinroot.com/gerard/pdf/P10.pdf

These 10 rules were written for C in spacecraft flight software. Below, each rule is
listed in its original form, then adapted for Eurisco's TypeScript codebase.

---

## The 10 Rules

### Rule 1: Simple Control Flow
**Original**: Restrict all code to very simple control flow constructs — do not use
goto statements, setjmp or longjmp constructs, or direct or indirect recursion.

**For Eurisco**: No recursion in the agent loop or tool execution. Use iterative loops
with explicit termination. No exceptions for flow control — use return values.

---

### Rule 2: Fixed Upper Bound on Loops
**Original**: Give all loops a fixed upper bound. It must be trivially possible for a
checking tool to prove statically that the loop cannot exceed a preset upper bound
on the number of iterations.

**For Eurisco**: The agent loop MUST have a max iterations guard (25). All retry loops
must have a max attempts count (3). No unbounded while(true) without a counter.

---

### Rule 3: No Dynamic Memory Allocation After Init
**Original**: Do not use dynamic memory allocation after initialization.

**For Eurisco**: Load all config, open all DB connections, and initialize all clients at
startup. During message handling, avoid creating new connections or large buffers.
Reuse objects. This also keeps RPi5 memory stable and predictable.

---

### Rule 4: Short Functions
**Original**: No function should be longer than what can be printed on a single sheet
of paper — roughly 60 lines of code per function.

**For Eurisco**: Max 60 lines per function. The agent loop is ~30 lines. Tool handlers
should be 10-30 lines each. If a function grows past 60, split it.

---

### Rule 5: Minimum Assertion Density
**Original**: The code's assertion density should average to minimally two assertions
per function.

**For Eurisco**: Validate inputs at boundaries — tool args from the LLM, API responses
from Gemini, config values at startup. Use TypeScript's type system as the primary
assertion mechanism. Add runtime checks where types can't protect (e.g., checking
that a person_id exists before logging an interaction).

---

### Rule 6: Smallest Possible Scope
**Original**: Declare all data objects at the smallest possible level of scope.

**For Eurisco**: Use `const` by default, `let` only when mutation is needed, never `var`.
Declare variables where they're used, not at the top of functions. Keep module-level
state to an absolute minimum — config, db connection, bot instance, that's it.

---

### Rule 7: Check All Return Values
**Original**: Each calling function must check the return value of nonvoid functions,
and each called function must check the validity of all parameters provided by the
caller.

**For Eurisco**: Every API call (Gemini, Gmail, Telegram) must have error handling. Tool
execution must catch errors and return them as strings to the LLM — never let a tool
crash the agent loop. Check that API responses have the expected shape before accessing
nested fields.

---

### Rule 8: Minimal Preprocessor / Build Magic
**Original**: The use of the preprocessor must be limited to the inclusion of header
files and simple macro definitions.

**For Eurisco**: Minimal TypeScript compiler options. No decorators, no reflect-metadata,
no complex generics gymnastics. tsconfig should be strict but simple. No build plugins
beyond tsc itself. The code should be readable without knowing the build system.

---

### Rule 9: Limit Indirection
**Original**: Limit pointer use to a single dereference, and do not use function
pointers.

**For Eurisco**: No deep callback chains. Limit promise nesting — use async/await
exclusively. The tool dispatch table (name → function) is the ONE allowed function
pointer pattern. Avoid dynamic imports, eval, or new Function(). No metaprogramming.

---

### Rule 10: Compile Clean
**Original**: Compile with all possible warnings active; all warnings should then
be addressed before the release of the software.

**For Eurisco**: TypeScript strict mode enabled (strict: true in tsconfig). Zero
type errors, zero warnings. ESLint with a minimal strict ruleset. No `any` types
except at the Gemini API boundary (where response shapes are dynamic). No
@ts-ignore without a comment explaining why.

---

## Summary for Eurisco Development

| Principle | Concrete Rule |
|-----------|--------------|
| Max agent loop iterations | 25 |
| Max retry attempts | 3 |
| Max function length | 60 lines |
| Max tool handler length | 30 lines |
| Default variable declaration | `const` |
| Module-level mutable state | config, db, bot only |
| Error handling | Catch at boundaries, return to LLM |
| TypeScript strictness | `strict: true`, zero `any` leaks |
| Dependencies | 5 total (grammy, google-ai, googleapis, better-sqlite3, node-cron) |
| Build system | tsc only, no plugins |

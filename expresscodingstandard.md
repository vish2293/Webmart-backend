Node.js + Express Backend Engineering Standards
Purpose: Establish consistent standards for building Node.js and Express backends that remain readable, testable, secure, and maintainable as features, traffic, and team size grow.

Applies to: Express APIs, background workers, integrations, authentication, authorization, database access, validation, logging, testing, and deployment.

Default approach: Use clear module boundaries, explicit contracts, validated inputs, centralized error handling, and small, reviewable changes. Do not add architectural complexity without a real need.

1. Core Principles
1. Clarity over cleverness. Make control flow and business rules easy to follow.
2. Separate responsibilities. Routes define HTTP endpoints; controllers handle HTTP concerns; services implement use cases; repositories handle persistence where useful.
3. Organize by feature. Keep code that changes together close together.
4. Validate at system boundaries. Treat request parameters, request bodies, headers, environment variables, and third-party responses as untrusted.
5. Centralize cross-cutting behavior. Use shared middleware for authentication, authorization, validation, logging, and error handling.
6. Keep business logic framework-independent where practical. Important rules should be testable without starting an Express server.
7. Make dependencies explicit. Avoid hidden global state and circular imports.
8. Design for failure. Network calls, databases, queues, and external APIs can fail or time out.
9. Automate consistency. Use formatting, linting, type checking, tests, and CI.
10. Scale by evidence. Start with a well-structured application; add processes, queues, caching, or service separation when measured needs justify them.
2. Recommended Project Structure
Use a feature-oriented structure for medium and large applications. Adapt it to the application's size and deployment model; do not create empty folders just to match a template.
src/
├── app.ts
├── server.ts
├── config/
├── routes/
├── middleware/
├── modules/
│   ├── projects/
│   │   ├── projects.routes.ts
│   │   ├── projects.controller.ts
│   │   ├── projects.service.ts
│   │   ├── projects.repository.ts
│   │   ├── projects.validation.ts
│   │   └── projects.types.ts
│   │
│   └── employees/
├── integrations/
├── jobs/
├── queues/
├── lib/
├── utils/
└── types/
What belongs where?
- app.ts: Create the Express app, register middleware, mount routes, and register not-found/error handlers. Do not start listening here.
- server.ts: Load configuration, connect required dependencies, start listening, and shut down gracefully.
- Routes: Define paths, HTTP methods, middleware order, and controller mappings. Keep route files thin.
- Controllers: Translate HTTP requests into service calls and translate results into HTTP responses. Avoid placing complex business rules here.
- Services: Implement application use cases and business rules. Coordinate repositories and integrations.
- Repositories: Encapsulate database queries and persistence details when the application benefits from that boundary.
- Validation: Define schemas for request parameters, query strings, bodies, and relevant configuration.
- Middleware: Implement reusable HTTP pipeline behavior such as authentication, authorization, request IDs, and error handling.
- Integrations: Wrap external APIs so business logic does not depend directly on SDK details.
- Jobs/workers: Execute background work independently from HTTP request handlers.
- Utilities: Hold pure functions that are genuinely shared. Do not turn this into a miscellaneous dumping ground.
Smaller projects
A small service can begin with routes/, controllers/, services/, middleware/, and config/. Introduce feature modules when the codebase becomes harder to navigate. Avoid both a single giant file and excessive layers for simple CRUD endpoints.
3. Request Flow and Module Boundaries
A common flow is:
HTTP Request
    ↓
Middleware (request ID, parsing, authentication)
    ↓
Router
    ↓
Validation + authorization
    ↓
Controller
    ↓
Service (use case and business rules)
    ↓
Repository / Integration
    ↓
Database or external system
    ↓
Controller → HTTP Response
Rules:
- Keep route definitions declarative and easy to scan.
- Keep controllers thin; they should not contain long SQL queries or large business workflows.
- Keep business rules in services or domain modules, not scattered through controllers.
- Keep database details out of route files and, where practical, out of services through repositories.
- Do not introduce a repository layer mechanically for every tiny service. Use one when it provides a useful boundary, isolates complex queries, or improves testing.
- Keep dependencies flowing inward: HTTP and infrastructure code can call business logic, but core business rules should not depend on Express request/response objects.
- Avoid circular dependencies between features.
- Avoid importing another feature's private implementation. Expose a small public interface when cross-feature use is necessary.
- Prefer explicit constructor/function parameters over mutable global singletons when practical.
4. Naming Conventions
Choose one consistent convention and apply it throughout the repository.
Item	Convention	Example
Files	Consistent kebab-case or feature-prefixed naming	projects.service.ts
Classes and types	PascalCase	ProjectService, ProjectRecord
Functions and variables	camelCase	getProjectById
Constants	camelCase by default; UPPER_SNAKE_CASE for true module-level constants where useful	defaultPageSize
Environment variables	UPPER_SNAKE_CASE	DATABASE_URL
Middleware	Describe behavior	authenticateRequest
Boolean values	is, has, can, should prefixes	isArchived, canEdit
Tests	Match module + .test or .spec	projects.service.test.ts
Error classes	Descriptive name ending in Error	NotFoundError


Rules:
- Use domain terminology consistently.
- Prefer names that communicate intent rather than implementation details.
- Avoid vague names such as data, item, helper, process, or doStuff when a more specific name is possible.
- Keep filenames and import casing consistent, including on case-sensitive deployment systems.
- Avoid abbreviations unless they are established in the project or domain.
5. TypeScript and JavaScript Standards
For new or substantially refactored services, TypeScript is recommended.
- Enable strict type checking and resolve type errors rather than broadly suppressing them.
- Avoid any. Use a specific type, unknown with narrowing, or a safe generic.
- Treat external data as unknown until validated.
- Type service inputs/outputs, public functions, repository contracts, and integration boundaries.
- Avoid unnecessary type assertions that silence compiler checks.
- Keep shared types genuinely shared; avoid one enormous types.ts.
- Use string-literal unions for finite states where suitable:type JobStatus = 'pending' | 'running' | 'completed' | 'failed';
- Do not confuse TypeScript types with runtime validation. Types disappear at runtime; validate HTTP and external inputs with schemas.
- If using JavaScript, use clear contracts and JSDoc for complex interfaces and public functions.
6. Environment and Configuration
- Validate required environment variables once at application startup.
- Fail fast with a clear configuration error if required values are missing or invalid.
- Keep environment access inside a configuration module rather than reading process.env throughout business code.
- Never commit real credentials, tokens, private keys, or production .env files.
- Provide a .env.example with placeholder values only.
- Distinguish development, test, and production configuration explicitly.
- Use safe defaults only when the default is genuinely appropriate.
- Never expose server-only secrets through frontend build variables or API responses.
- Avoid using production services or production credentials in tests.
- Document required environment variables, formats, and purpose.
Example configuration shape:
// config/env.ts
import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
});

export const env = envSchema.parse(process.env);
This is an illustrative example. Adapt schema and secret requirements to the application's actual authentication and deployment design.
7. Express Application Setup
Keep application setup separate from process startup.
- Register middleware in a deliberate order.
- Parse request bodies with appropriate size limits.
- Configure CORS for known allowed origins; do not use permissive production settings without a specific reason.
- Apply security headers using a maintained solution such as Helmet where appropriate.
- Configure request logging and request IDs.
- Mount routers under a consistent API prefix, such as /api/v1, when versioning is useful.
- Register not-found handling after routes.
- Register the centralized error handler last.
- Avoid doing slow startup work for every incoming request.
- Avoid defining routes inside request handlers.
- Do not start background worker loops as an accidental side effect of importing a module.
A typical high-level setup:
// app.ts
import express from 'express';
import helmet from 'helmet';
import { routes } from './routes';
import { notFound } from './middleware/notFound';
import { errorHandler } from './middleware/errorHandler';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));

  app.use('/api/v1', routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
The example omits application-specific CORS, authentication, logging, and other middleware. Add them based on the actual API requirements and in the correct order.
8. Routes and Controllers
Routes
- Define one endpoint per clear HTTP operation.
- Apply authentication, authorization, and validation middleware explicitly.
- Keep route files focused on wiring, not business logic.
- Use consistent resource naming and HTTP semantics.
- Avoid overly broad catch-all routes.
- Keep API versioning and route prefixes consistent.
Controllers
- Extract validated request data.
- Call the appropriate service.
- Set the correct status code and response shape.
- Forward errors to the centralized error handler.
- Avoid direct SQL, long workflows, repeated validation logic, and external API implementation details.
- Do not return internal stack traces, database messages, or secrets to clients.
- Do not send a response more than once.
- Keep response contracts consistent across endpoints.
Illustrative controller:
export async function getProjectController(req, res, next) {
  try {
    const project = await projectService.getById(req.params.projectId);
    res.status(200).json({ data: project });
  } catch (error) {
    next(error);
  }
}
Use proper request/response types and a project-wide async error-handling convention. Some Express versions/wrappers automatically forward rejected async handlers; do not mix patterns inconsistently.
9. Validation and Input Handling
All client input is untrusted—even if the frontend validates it.
- Validate route parameters, query parameters, request bodies, uploaded files, and relevant headers.
- Use a schema library such as Zod, Joi, or an equivalent consistent tool.
- Validate types, lengths, ranges, formats, allowed values, and cross-field constraints.
- Reject malformed input with a predictable 400 Bad Request response.
- Use 401 Unauthorized for missing/invalid authentication and 403 Forbidden for authenticated users lacking permission.
- Use parameterized SQL queries or safe ORM query APIs. Never concatenate user input into SQL.
- Validate pagination limits and apply reasonable maximums.
- Normalize inputs only where the domain requires it; do not silently change meaningful user data.
- Validate external API responses before relying on their shape.
- Avoid duplicating the same schema rules in multiple unrelated places.
- Keep validation separate from business authorization: valid input does not mean the user is allowed to perform the action.
10. Error Handling
Use one predictable error-handling strategy.
Rules
- Use a centralized Express error middleware.
- Represent expected application failures with meaningful error types or stable error codes.
- Distinguish validation errors, authentication errors, authorization errors, not-found errors, conflicts, rate limits, and unexpected failures.
- Log unexpected errors with a request ID and enough diagnostic context to investigate.
- Return a safe public error response; do not leak stack traces or internal details in production.
- Do not swallow errors or log-and-continue when the operation has actually failed.
- Avoid nested try/catch blocks that only rethrow the same error.
- Add context when rethrowing an error if it materially improves diagnosis.
- Handle rejected promises and callback errors correctly.
- Never assume a failed external call can be retried safely; consider idempotency and the operation's side effects.
Suggested response shape:
{
  "error": {
    "code": "PROJECT_NOT_FOUND",
    "message": "The requested project was not found",
    "requestId": "req_example"
  }
}
Use a stable response format and avoid exposing SQL, file paths, internal hostnames, tokens, or stack traces.
11. Authentication and Authorization
Authentication establishes who the caller is. Authorization determines what that caller can do. Both must be enforced on the backend.
- Centralize token/session verification in authentication middleware.
- Enforce authorization for every protected resource and operation.
- Do not trust user IDs, roles, team IDs, tenant IDs, or ownership claims supplied by the client without verifying them.
- Derive trusted identity and access scope from verified credentials and server-side data.
- Check object-level permissions to prevent insecure direct object reference (IDOR) vulnerabilities.
- Apply least privilege to database users, service credentials, and external integrations.
- Use secure password hashing through a well-maintained password-hashing library when passwords are managed by the application.
- Use appropriate session/token expiry, rotation, revocation, and cookie settings for the application's authentication design.
- Rate-limit sensitive endpoints such as login, password reset, and verification flows.
- Avoid logging authorization headers, tokens, passwords, or session identifiers.
- Keep frontend route guards as a UX feature only; the backend remains authoritative.
- Test both allowed and denied cases, including cross-user and cross-tenant access.
12. Database and Persistence
Keep persistence code predictable, safe, and observable.
- Use a maintained driver or ORM and follow its established patterns.
- Reuse a connection pool instead of opening a new database connection for each request.
- Use parameterized queries.
- Keep schema changes in version-controlled migrations.
- Define transaction boundaries around operations that must succeed or fail together.
- Keep transactions short; avoid holding locks while waiting on external APIs.
- Add indexes based on query patterns and query plans, not guesswork alone.
- Paginate large result sets and avoid unbounded queries.
- Select only the columns needed for the task.
- Avoid N+1 query patterns.
- Handle unique constraints and concurrent updates deliberately.
- Use database constraints for important integrity rules, not just application-level checks.
- Avoid leaking database-specific error details to clients.
- Do not run destructive schema changes automatically at application startup in production unless the migration system explicitly supports a safe deployment process.
- Define how migrations are run and rolled back or repaired.
Transactions and concurrency
- Use a transaction when multiple database changes must be atomic.
- Understand the isolation level and locking behavior relevant to the operation.
- Do not assume a read-then-write sequence is safe under concurrent requests.
- Use unique constraints, conditional updates, row locks, or idempotency keys when appropriate.
- Design retries so a repeated operation cannot accidentally duplicate side effects.
13. Services and Business Logic
- Name service functions after use cases, such as createProject, archiveEmployee, or scheduleSearchJob.
- Keep business rules explicit and close to the domain that owns them.
- Avoid services that become giant collections of unrelated operations.
- Break long workflows into named, cohesive functions.
- Pass dependencies and inputs explicitly where practical.
- Keep pure calculations and transformations separate from I/O.
- Avoid importing Express types into core business rules.
- Do not duplicate rules across routes, workers, and scheduled jobs; place them in a shared domain/service module when ownership is clear.
- Avoid overly generic service functions with many optional parameters and unclear behavior.
- Make side effects visible in function names, interfaces, or documentation.
14. External APIs and Integrations
Assume every external dependency can be slow, unavailable, rate-limited, or inconsistent.
- Wrap each significant external API/SDK in a small integration module.
- Set explicit connection and request timeouts.
- Handle rate limits and transient errors according to the provider's guidance.
- Use bounded retries with exponential backoff and jitter where appropriate.
- Retry only operations that are safe to retry or protected by idempotency.
- Respect provider quotas and concurrency limits.
- Validate third-party responses.
- Normalize provider-specific responses into application-level types.
- Store credentials securely and rotate them when needed.
- Redact sensitive fields from logs.
- Provide fallbacks or clear failure behavior where the product requires them.
- Use circuit breakers only when justified by failure patterns and operational needs.
- Do not block an HTTP response on long-running work that can safely be processed asynchronously.
15. Background Jobs, Workers, and Schedulers
Use background processing for long-running, retryable, scheduled, or non-interactive work.
- Keep worker entry points separate from HTTP route modules.
- Decide explicitly whether workers run in the API process or as separate processes.
- Ensure importing a worker module does not automatically start loops as an unintended side effect.
- Make job handlers idempotent where possible.
- Model job states and retry behavior explicitly.
- Use bounded concurrency; do not launch unlimited promises for a large queue.
- Set timeouts and define retry/backoff policies.
- Record attempts, errors, timestamps, and final outcomes.
- Prevent duplicate job claims using database transactions, atomic updates, or queue guarantees.
- Use leases/visibility timeouts or heartbeats for work that can exceed a claim period.
- Handle worker crashes and abandoned jobs.
- Ensure scheduled tasks do not run multiple times unintentionally when the service has multiple replicas.
- Provide graceful worker shutdown and stop claiming new jobs during shutdown.
- Use a durable queue or separate worker process when workload isolation, retries, concurrency control, or independent scaling warrants it.
- Monitor queue depth, oldest job age, failures, retries, and processing duration.
A worker in the same Node.js process can be reasonable for a small, low-volume application. Separate workers become useful when CPU/memory isolation, independent scaling, deployment control, or failure isolation matters. Choose based on workload and operational evidence rather than assuming one model is always best.
16. Logging, Monitoring, and Observability
- Use structured logs (for example, JSON) in production.
- Include a request/correlation ID in logs and error responses where appropriate.
- Log meaningful events and outcomes, not every trivial variable.
- Record latency, status code, dependency failures, job duration, retries, and queue health.
- Redact secrets and sensitive personal data.
- Use log levels consistently: debug, info, warn, and error.
- Avoid console.log as the only production observability strategy.
- Use error monitoring and metrics when the application's impact justifies them.
- Add health endpoints with clear semantics:
  - Liveness: Is the process alive and able to continue?
  - Readiness: Can it safely receive traffic, including required dependency checks?
- Avoid exposing detailed infrastructure state through public health endpoints.
- Do not treat “the server returned 200” as proof that all background work is healthy.
17. Security Baseline
- Use TLS at the appropriate edge/load balancer and secure internal transport where required.
- Set security headers, typically with Helmet.
- Configure CORS for the actual client origins and required methods/headers.
- Apply request body and upload size limits.
- Rate-limit endpoints based on risk and expected traffic.
- Validate and sanitize input according to context; use output encoding and safe templating.
- Prevent SQL injection with parameterized queries or safe ORM APIs.
- Avoid unsafe deserialization and dynamic code execution.
- Prevent path traversal when handling file paths and user-supplied filenames.
- Restrict file types and sizes; scan uploaded files when the risk requires it.
- Avoid Server-Side Request Forgery (SSRF) when users can provide URLs; validate destinations and block private/internal network targets as appropriate.
- Use least-privilege service and database credentials.
- Keep dependencies patched and review dependency changes.
- Do not return stack traces or raw internal errors in production.
- Do not store secrets in source control or logs.
- Establish a backup and restore strategy for important data.
- Use dependency/security scanning in CI where appropriate.
Security middleware does not replace correct authorization, validation, and safe database access.
18. HTTP API Design
- Use consistent resource names and HTTP methods.
- Return appropriate status codes.
- Keep response envelopes consistent across endpoints.
- Define pagination, filtering, sorting, and error formats consistently.
- Use a stable error code separate from the human-readable message.
- Validate and bound page sizes.
- Use 201 Created for successful resource creation when appropriate, 204 No Content when no body is needed, and appropriate 4xx/`5xx` codes for failures.
- Avoid returning more data than the caller needs.
- Keep API contracts documented using OpenAPI or an equivalent format when useful.
- Treat breaking changes deliberately; use versioning or a compatibility strategy.
- Use idempotency keys for high-impact operations when duplicate requests could cause harm.
- Do not expose internal database schema directly as the permanent public API contract.
19. Performance and Scalability
- Measure before optimizing.
- Keep synchronous CPU-heavy work out of the Node.js event loop. Use worker threads, child processes, or background workers when justified.
- Avoid blocking operations and synchronous filesystem APIs in request paths.
- Set timeouts for outbound calls and database operations where supported.
- Use connection pooling and monitor pool saturation.
- Paginate large result sets.
- Avoid loading entire tables, files, or API result sets into memory without limits.
- Bound concurrency for fan-out operations.
- Cache only when there is a clear invalidation and consistency strategy.
- Use compression appropriately, considering CPU cost and proxy configuration.
- Avoid excessive middleware and repeated serialization or transformation.
- Use streaming for genuinely large payloads when appropriate.
- Keep stateless API instances where practical to support horizontal scaling.
- Move durable long-running work to a queue when request timeouts or resource contention become a concern.
- Measure CPU, memory, event-loop delay, request latency, error rate, and database pool utilization under realistic load.
20. Testing Strategy
Test behavior at boundaries and around important business rules.
Recommended layers
1. Unit tests: Pure business rules, validators, transformations, and calculations.
2. Service tests: Use cases with controlled repository/integration dependencies.
3. Integration tests: Real or test-instance database, migrations, middleware, and HTTP endpoints.
4. End-to-end tests: Critical user journeys across the API and its dependencies where appropriate.
5. Worker tests: Retry rules, duplicate claims, idempotency, failure recovery, and state transitions.
Rules:
- Test success and failure cases.
- Test malformed input, missing auth, insufficient permissions, not-found cases, conflicts, and boundary values.
- Test cross-user/cross-tenant access explicitly.
- Test transaction behavior for multi-step updates.
- Test external integrations through controlled mocks or provider sandboxes; do not rely on unstable live APIs in ordinary CI.
- Keep tests deterministic and independent.
- Use isolated test databases or safe fixtures; never run destructive tests against production.
- Verify response status, shape, and side effects.
- Avoid testing private implementation details when a behavior-level assertion is sufficient.
- Fix flaky tests instead of repeatedly rerunning them.
- Protect critical business rules and workflows rather than chasing a meaningless coverage percentage.
21. Dependency Management and Code Quality Automation
Use automated checks locally and in CI.

Recommended baseline:
- Formatter: Prettier.
- Linting: ESLint with TypeScript and Node.js rules appropriate to the project.
- Type checking: tsc --noEmit or the project's equivalent.
- Tests: Unit and integration tests.
- Build: Production compilation/build must pass.
- Dependency review: Keep dependencies maintained and remove unused packages.
- CI: Run required checks for every pull request.
- Migrations: Verify migration steps in a safe test environment.
- Security checks: Scan dependencies and secrets where appropriate.
Example scripts (adapt to the project's runtime, package manager, and build tool):
{
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
These scripts are illustrative. Confirm that the chosen tools are installed and that the TypeScript output directory and runtime paths match the project's configuration. Do not copy them blindly.
22. File Size and Complexity Guidelines
There is no universal correct line limit. Treat these as review triggers, not strict rules:
- Around 150–250 lines in a controller or service: check whether it has multiple responsibilities.
- Around 300–500 lines in a module: consider extracting cohesive parts.
- A function with many branches, nested conditions, or too many parameters deserves review regardless of file size.
- A controller containing substantial SQL, integration logic, and business rules is likely doing too much.
- A feature importing private files from many other features may have unclear ownership.
When a file grows:
1. Identify distinct responsibilities and business concepts.
2. Extract cohesive functions or modules with clear names.
3. Move HTTP handling to controllers and business rules to services.
4. Move persistence into a repository where that boundary helps.
5. Isolate external APIs behind integration modules.
6. Add tests around behavior before or during risky refactoring.
7. Keep interfaces small and dependency direction clear.
8. Avoid splitting code into many tiny files that are harder to navigate than the original.
Do not split code only to reduce line count. Optimize for cohesion, discoverability, and safe change.
23. Anti-Patterns to Avoid
Avoid these patterns unless there is a clear, documented reason:
- A single server.ts containing all routes, SQL, authentication, business logic, and worker loops.
- Large controllers that implement complete workflows.
- Repeating validation, authorization, or error-response logic across routes.
- Building SQL with string concatenation from user input.
- Reading process.env throughout the application without central validation.
- Catching errors and silently ignoring them.
- Returning raw stack traces or database errors to clients.
- Using any or type assertions to bypass the type system everywhere.
- Creating a generic repository/service/base-controller framework before it solves a real problem.
- Giant utils.ts, types.ts, or constants.ts files.
- Circular imports between features.
- Hidden background loops that start during module import.
- Unbounded Promise.all over large input sets.
- Retrying non-idempotent operations without safeguards.
- Holding database transactions open while calling external APIs.
- Running scheduled jobs independently on every API replica without coordination.
- Using in-memory state as durable job storage when restarts or multiple replicas matter.
- Treating frontend permissions as backend security.
- Refactoring the whole backend in one large, difficult-to-review change.
24. Practical Pull Request Checklist
Architecture and maintainability
- [ ] Each module has a clear responsibility.
- [ ] Routes are thin and controllers focus on HTTP concerns.
- [ ] Business rules are in services/domain modules.
- [ ] Database and external API details are isolated appropriately.
- [ ] No unnecessary circular or cross-feature private imports.
- [ ] Names and contracts are clear.
Input and HTTP behavior
- [ ] Request data is validated.
- [ ] Authentication and authorization are enforced server-side.
- [ ] Status codes and response formats are consistent.
- [ ] Error handling uses the central error strategy.
- [ ] Pagination and request limits are bounded where needed.
Reliability and data
- [ ] Database queries are safe and efficient.
- [ ] Transactions and concurrency are handled where needed.
- [ ] External calls have timeouts and appropriate failure behavior.
- [ ] Retries are bounded and safe.
- [ ] Background jobs are idempotent or protected against duplicates.
- [ ] Logs include useful context without sensitive data.
Security
- [ ] No secrets are committed or exposed.
- [ ] No raw internal errors are returned.
- [ ] Object-level access checks are tested.
- [ ] Input, upload, URL, and database risks are considered.
- [ ] Dependencies and configuration follow project standards.
Verification
- [ ] Relevant tests were added or updated.
- [ ] Lint passes.
- [ ] Type checking passes, if applicable.
- [ ] Production build passes.
- [ ] Migrations are tested safely, if applicable.
- [ ] Significant trade-offs are documented.
25. Suggested Team Workflow
1. Understand the use case: identify the endpoint, actors, permissions, data model, side effects, and failure cases.
2. Find the owning feature: put the change in the feature that owns the business concept.
3. Define the contract: determine request schema, response shape, status codes, and authorization rules.
4. Implement the smallest complete path: route → validation/auth → controller → service → persistence/integration.
5. Handle failure deliberately: consider database errors, external timeouts, retries, and partial completion.
6. Test the behavior: include success, invalid input, permission denial, and important edge cases.
7. Run automated checks: lint, type check, tests, and build.
8. Review operational impact: logs, metrics, migrations, job behavior, and deployment settings.
9. Keep the pull request focused: avoid unrelated rewrites.
10. Refactor incrementally: improve the code without changing unrelated behavior.
26. Production Readiness and Lifecycle
Startup
- Validate configuration before accepting traffic.
- Establish required database and infrastructure connections.
- Start workers explicitly and only when this process is intended to own them.
- Fail startup if critical dependencies cannot be initialized safely.
Shutdown
- Handle termination signals such as SIGTERM and SIGINT.
- Stop accepting new HTTP requests.
- Stop claiming new jobs and allow in-flight work to finish within a defined grace period.
- Close database pools, queue connections, and other resources.
- Set a shutdown timeout and handle work that cannot finish in time.
Deployment
- Run migrations through a controlled deployment step.
- Use health/readiness checks correctly.
- Ensure the service can restart without losing critical work.
- Avoid depending on local disk or in-memory state for data that must survive restarts or be shared across replicas.
- Monitor error rate, latency, resource usage, and background job health after release.
- Keep a rollback or recovery plan for risky deployments.
Final Rule
Optimize for safe change, clear ownership, and predictable failure handling—not for the fewest files or the most elaborate architecture.

A maintainable Node.js + Express backend combines clear feature boundaries, explicit validation, centralized errors, secure authorization, safe persistence, observable background work, meaningful
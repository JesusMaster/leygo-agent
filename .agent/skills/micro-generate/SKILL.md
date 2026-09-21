---
name: micro-generate-helper
description: Use the micro-generate CLI non-interactively to generate features, queries, mutations, standalone models, and add database/cache configurations to existing projects.
---

# Micro-Generate Skill

This skill allows you to programmatically invoke the \`micro-generate\` CLI tools to create features, GraphQL operations, standalone models, and database/cache connectors without user interaction.

## Usage

You should use your terminal or command-execution tool to execute the \`npx micro-generate\` command directly. The CLI supports headless execution via flags for all commands.

---

## 🔄 Recommended Workflow (Order of Operations)

When implementing a new feature or database configuration, follow this exact sequence:

1. **Initialize Technologies (If missing)**: If the project does not have the database/cache you need, run the \`add\` command first.
2. **Scaffold the Feature**: Execute the \`feature\` command to generate the vertical slice folder structure.
3. **Scaffold Standalone Models (Optional)**: If you need separate standalone models not coupled to a single feature, run the \`model\` command.
4. **Scaffold Operations**: Use the \`query\` and \`mutation\` commands to add GraphQL endpoints.
5. **Implement Business Logic**: Open and implement the business logic in the generated files (see **Landing Paths** below).
6. **Verify and Self-Correct**: Run verification commands to ensure the project builds and runs without TypeScript or runtime errors.

---

## 📂 File Landing Paths & Architectural Conventions

After running the CLI generators, you **must** locate and write the actual implementation in the following paths:

*   **GraphQL Schema**: \`src/features/<feature-name>/typeDefs.ts\`
    *   *Convention*: Declare your types, queries, and mutations here. The CLI inserts new operations, but you must define arguments and return types.
*   **GraphQL Resolvers**: \`src/features/<feature-name>/resolvers.ts\`
    *   *Convention*: Map the schema queries/mutations to call the corresponding service methods. Keep resolvers thin.
*   **Business Logic / Services**: \`src/features/<feature-name>/service.ts\`
    *   *Convention*: Implement your database queries, data mutations, APIs, and caching operations here. 
*   **Feature-coupled Models**: \`src/features/<feature-name>/model.ts\` (or under \`src/database/<mongo|mysql>/models/\` if standalone).
    *   *Convention*: Define your mongoose schemas or sequelize schemas.
*   **Feature Entrypoint**: \`src/features/<feature-name>/index.ts\`
    *   *Convention*: Aggregates typeDefs, resolvers, and services. It is automatically registered in \`src/features/index.ts\`.

---

## 🛠️ CLI Command Reference & Preconditions

Execute these commands using your terminal or command-execution tool.

### 1. \`add <technology>\`
Adds database/cache configurations to the project.
*   **Preconditions**: None.
*   **Usage**: \`npx micro-generate add <redis | mongo | mysql>\`
*   **Options**:
    *   \`-n, --name <string>\`: (Optional) Default database name (for MongoDB/MySQL).
    *   \`-s, --secondary <string>\`: (Optional) Comma-separated list of secondary databases to add (for MongoDB/MySQL).
    *   *Note*: For Redis, it sets up the main connection parameters in \`.env\`. Redis does not require secondary connection parameters as multiple databases are accessed by index.
*   **Example**:
    \`\`\`bash
    npx micro-generate add mongo --name "my_core" --secondary "logs,analytics"
    \`\`\`

### 2. \`feature\`
Creates a new vertical slice module.
*   **Preconditions**: If database/cache flags (\`--mongo\`, \`--mysql\`, \`--redis\`) are passed, those technologies must be configured in the project (either initialized at project creation or added using the \`add\` command).
*   **Usage**: \`npx micro-generate feature --name <name> [options]\`
*   **Options**:
    *   \`--mongo\` / \`--no-mongo\`: Enable/disable MongoDB support.
    *   \`--mysql\` / \`--no-mysql\`: Enable/disable MySQL support.
    *   \`--redis\` / \`--no-redis\`: Enable/disable Redis support.
    *   \`--db-connection <string>\`: (Optional) Connect to a specific MongoDB database name (Multi-DB).
    *   \`--mysql-connection <string>\`: (Optional) Connect to a specific MySQL database name (Multi-DB).
    *   \`--redis-db <number>\`: (Optional) Connect to a specific Redis database number (0-15).
*   **Example**:
    \`\`\`bash
    npx micro-generate feature --name "billing" --mysql --redis --mysql-connection "payments" --redis-db 2
    \`\`\`

### 3. \`model\`
Generates a standalone database model.
*   **Preconditions**: The selected database type must be configured in the project.
*   **Usage**: \`npx micro-generate model --name <name> --type <mongo | mysql> [options]\`
*   **Options**:
    *   \`-n, --name <string>\`: (Required) Model name (e.g., "Invoice").
    *   \`-t, --type <string>\`: (Required) Database type (\`mongo\` or \`mysql\`).
    *   \`-c, --connection <string>\`: (Optional) Connection name (defaults to default).
*   **Example**:
    \`\`\`bash
    npx micro-generate model --name "Invoice" --type "mysql" --connection "billing"
    \`\`\`

### 4. \`query\` and \`mutation\`
Adds a new GraphQL operation to an existing feature.
*   **Preconditions**: The target feature must already exist under \`src/features/<feature-name>\`.
*   **Usage**: \`npx micro-generate <query | mutation> --feature <feature-name> --name <name> [options]\`
*   **Options**:
    *   \`-f, --feature <string>\`: (Required) Target feature.
    *   \`-n, --name <string>\`: (Required) Operation name (e.g., "getInvoice").
    *   \`-r, --return-type <string>\`: (Optional) Return type (e.g., "InvoiceResponse").
*   **Example**:
    \`\`\`bash
    npx micro-generate query --feature "billing" --name "getInvoice" --return-type "Invoice"
    \`\`\`

---

## 📝 End-to-End Example: Implementing a Feature

Here is how you would implement a new feature called "notifications" that uses MySQL and Redis:

1.  **Generate the feature**:
    \`\`\`bash
    npx micro-generate feature --name "notifications" --mysql --redis --redis-db 1
    \`\`\`
2.  **Add a query**:
    \`\`\`bash
    npx micro-generate query --feature "notifications" --name "getUserNotifications" --return-type "[Notification!]"
    \`\`\`
3.  **Implement database schema**:
    Open the generated model file in \`src/features/notifications/model.ts\` (or standalone model) and define the fields (e.g., \`title\`, \`message\`, \`userId\`, \`read\`).
4.  **Write the business logic**:
    Open \`src/features/notifications/service.ts\`. Add code to fetch notifications from the MySQL database and cache them in Redis.
5.  **Hook up the resolver**:
    Open \`src/features/notifications/resolvers.ts\` and map the query to your service method.
6.  **Verify**:
    Run \`npm run build\` to ensure it compiles without TypeScript errors.

---

## 🔍 Verification & Self-Correction Loop

Always verify your changes after generating or modifying files:

1.  **Check Registration**: Ensure that your feature is listed in \`src/features/index.ts\`. The CLI registers new features automatically, but verify that it was not corrupted:
    \`\`\`typescript
    import * as notifications from './notifications/index.js';
    \`\`\`
2.  **Compile Project**: Run the TypeScript compiler to ensure there are no syntax or type mismatches:
    \`\`\`bash
    npm run build
    \`\`\`
3.  **Read and Correct Errors**: If \`tsc\` fails:
    *   Read the line number and error description.
    *   Check for missing imports or incorrect relative paths (e.g., missing \`.js\` in TypeScript ESM imports).
    *   Fix the types and compile again until it builds with **0 errors**.

# Contributing to Hamplard Backend

Thank you for your interest in contributing to the Hamplard backend! This guide will help you get set up and understand our development workflow.

---

## Table of Contents

- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Branching Strategy](#branching-strategy)
- [Development Workflow](#development-workflow)
- [Testing Guidelines](#testing-guidelines)
- [Code Standards](#code-standards)
- [Commit Guidelines](#commit-guidelines)
- [Pull Request Process](#pull-request-process)
- [Database Migrations](#database-migrations)
- [Troubleshooting](#troubleshooting)

---

## Getting Started

### Prerequisites

Before you begin, ensure you have the following installed:

- **Node.js** (v18 or higher)
- **npm** (v9 or higher)
- **PostgreSQL** (v14 or higher)
- **Redis** (v6 or higher)
- **Git**
- **Docker & Docker Compose** (optional, for containerized development)

### Technologies Used

- **NestJS** — Backend framework
- **Prisma** — ORM and database migrations
- **PostgreSQL** — Primary database
- **Redis** — Caching and job queues (BullMQ)
- **Stellar SDK** — Blockchain integration
- **Jest** — Testing framework

---

## Development Setup

### 1. Fork and Clone the Repository

```bash
# Fork the repository on GitHub, then clone your fork
git clone https://github.com/YOUR_USERNAME/hamplard-backend.git
cd hamplard-backend

# Add the upstream remote
git remote add upstream https://github.com/hamplard/hamplard-backend.git
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Set Up Environment Variables

```bash
# Copy the example environment file
cp .env.example .env.local

# Edit .env.local with your local configuration
nano .env.local
```

**Minimum required variables for local development:**

```env
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://hamplard:password@localhost:5432/hamplard_db
JWT_SECRET=your-local-jwt-secret
REDIS_URL=redis://localhost:6379
STELLAR_NETWORK=testnet
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
```

### 4. Set Up the Database

```bash
# Start PostgreSQL (if using Docker)
docker-compose up -d postgres

# Run database migrations
npx prisma migrate dev

# (Optional) Seed the database with test data
npx prisma db seed
```

### 5. Start Redis

```bash
# Using Docker
docker-compose up -d redis

# Or install and run locally
redis-server
```

### 6. Start the Development Server

```bash
# Start in watch mode
npm run start:dev

# The API will be available at http://localhost:3000
# Swagger docs at http://localhost:3000/api/v1/docs
```

### 7. Verify the Setup

```bash
# Health check
curl http://localhost:3000/api/v1/health

# Expected response: {"status":"ok","database":"connected"}
```

---

## Project Structure

```
hamplard-backend/
├── prisma/
│   ├── schema.prisma          # Database schema
│   ├── migrations/            # Database migrations
│   └── seed.ts                # Database seeding script
│
├── src/
│   ├── main.ts                # Application entry point
│   ├── app.module.ts          # Root module
│   │
│   ├── common/                # Shared utilities
│   │   ├── prisma/            # PrismaService
│   │   ├── stellar/           # StellarService
│   │   ├── guards/            # Auth guards
│   │   ├── decorators/        # Custom decorators
│   │   ├── filters/           # Exception filters
│   │   └── interceptors/      # Response interceptors
│   │
│   └── modules/               # Feature modules
│       ├── auth/              # Authentication
│       ├── users/             # User management
│       ├── courses/           # Course CRUD
│       ├── lessons/           # Lesson content
│       ├── enrollments/       # Enrollment tracking
│       ├── assignments/       # Assignment workflow
│       ├── certificates/      # Certificate issuance
│       ├── events/            # Stellar event poller
│       ├── notifications/     # Email & in-app notifications
│       ├── uploads/           # File upload handling
│       └── health/            # Health checks
│
├── test/                      # E2E tests
├── uploads/                   # Local file storage (gitignored)
├── .env.example               # Environment variable template
├── .env.local                 # Your local config (gitignored)
├── docker-compose.yml         # Local services
└── package.json               # Dependencies and scripts
```

---

## Branching Strategy

We follow **Git Flow** with the following branch structure:

### Main Branches

- **`main`** — Production-ready code. Protected branch.
- **`develop`** — Integration branch for features. Protected branch.

### Supporting Branches

- **`feature/*`** — New features (branch from `develop`)
- **`bugfix/*`** — Bug fixes (branch from `develop`)
- **`hotfix/*`** — Critical production fixes (branch from `main`)
- **`release/*`** — Release preparation (branch from `develop`)

### Branch Naming Convention

```bash
feature/brief-description-of-feature
bugfix/issue-number-brief-description
hotfix/critical-issue-description
release/v1.2.0
```

**Examples:**

```bash
feature/add-course-rating-system
bugfix/123-fix-enrollment-progress-calculation
hotfix/jwt-expiration-bug
release/v1.1.0
```

---

## Development Workflow

### 1. Create a New Branch

```bash
# Update your local develop branch
git checkout develop
git pull upstream develop

# Create a feature branch
git checkout -b feature/your-feature-name
```

### 2. Make Your Changes

- Write clean, maintainable code
- Follow the existing code style and patterns
- Add tests for new functionality
- Update documentation as needed

### 3. Test Your Changes

```bash
# Run all tests
npm test

# Run tests in watch mode during development
npm run test:watch

# Run tests with coverage
npm run test:cov

# Run linting
npm run lint

# Format code
npm run format
```

### 4. Commit Your Changes

```bash
# Stage your changes
git add .

# Commit with a descriptive message
git commit -m "feat: add course rating system"
```

See [Commit Guidelines](#commit-guidelines) for commit message format.

### 5. Keep Your Branch Updated

```bash
# Fetch latest changes from upstream
git fetch upstream

# Rebase your branch on develop
git rebase upstream/develop

# If conflicts occur, resolve them and continue
git rebase --continue
```

### 6. Push Your Branch

```bash
# Push to your fork
git push origin feature/your-feature-name
```

### 7. Create a Pull Request

- Go to the GitHub repository
- Click "New Pull Request"
- Select your branch
- Fill out the PR template
- Request reviews from maintainers

---

## Testing Guidelines

### Test Structure

We use **Jest** as our testing framework. Tests are located alongside their source files:

```
src/modules/courses/
├── courses.controller.ts
├── courses.controller.spec.ts    # Unit tests for controller
├── courses.service.ts
└── courses.service.spec.ts       # Unit tests for service
```

E2E tests are in the `test/` directory:

```
test/
├── auth.e2e-spec.ts
├── courses.e2e-spec.ts
└── enrollments.e2e-spec.ts
```

### Writing Tests

#### Unit Tests

```typescript
describe('CoursesService', () => {
  let service: CoursesService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoursesService,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    service = module.get<CoursesService>(CoursesService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  it('should create a new course', async () => {
    // Test implementation
  });
});
```

#### E2E Tests

```typescript
describe('Courses (e2e)', () => {
  let app: INestApplication;
  let authToken: string;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    // Get auth token
    const authResponse = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ address: 'test-address', signature: 'test-signature' });
    
    authToken = authResponse.body.access_token;
  });

  it('/courses (GET)', () => {
    return request(app.getHttpServer())
      .get('/api/v1/courses')
      .expect(200);
  });

  afterAll(async () => {
    await app.close();
  });
});
```

### Test Coverage Requirements

- **New features** — Must have unit tests covering core logic
- **Bug fixes** — Should include a test that reproduces the bug
- **Controllers** — Test HTTP responses and status codes
- **Services** — Test business logic and edge cases
- **Target coverage** — Aim for >80% coverage on new code

### Running Specific Tests

```bash
# Run tests for a specific file
npm test -- courses.service.spec.ts

# Run tests matching a pattern
npm test -- --testNamePattern="should create"

# Run tests in a specific directory
npm test -- src/modules/courses

# Run with verbose output
npm test -- --verbose
```

---

## Code Standards

### TypeScript Guidelines

- Use **TypeScript** strict mode
- Define explicit types for function parameters and return values
- Use interfaces for object shapes
- Avoid `any` type — use `unknown` if type is truly unknown

### NestJS Best Practices

- Use **dependency injection** for all services
- Implement **DTOs** for request validation
- Use **decorators** for route guards and metadata
- Keep controllers thin — business logic belongs in services
- Use **Prisma** for all database operations

### Code Style

We use **ESLint** and **Prettier** for code formatting:

```bash
# Format all files
npm run format

# Check for linting errors
npm run lint

# Fix linting errors automatically
npm run lint -- --fix
```

**Key style rules:**

- Use single quotes for strings
- 2-space indentation
- No trailing commas in objects
- Semicolons required
- Max line length: 100 characters

### File Naming Conventions

- **Controllers**: `resource.controller.ts`
- **Services**: `resource.service.ts`
- **DTOs**: `create-resource.dto.ts`, `update-resource.dto.ts`
- **Entities**: `resource.entity.ts`
- **Guards**: `resource.guard.ts`
- **Decorators**: `decorator-name.decorator.ts`

### Error Handling

Always use NestJS exception filters:

```typescript
import { NotFoundException, BadRequestException } from '@nestjs/common';

// Good
if (!course) {
  throw new NotFoundException(`Course with ID ${id} not found`);
}

// Good
if (enrollmentPercentage < 100) {
  throw new BadRequestException('Course must be 100% complete before issuing certificate');
}
```

---

## Commit Guidelines

We follow the **Conventional Commits** specification:

### Commit Message Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types

- **feat**: New feature
- **fix**: Bug fix
- **docs**: Documentation changes
- **style**: Code style changes (formatting, missing semicolons, etc.)
- **refactor**: Code refactoring (no functionality change)
- **perf**: Performance improvements
- **test**: Adding or updating tests
- **chore**: Build process or auxiliary tool changes
- **ci**: CI/CD configuration changes

### Examples

```bash
# Feature addition
git commit -m "feat(courses): add course rating system"

# Bug fix
git commit -m "fix(enrollments): correct progress calculation for completed lessons"

# Documentation
git commit -m "docs(readme): update API endpoint documentation"

# Breaking change
git commit -m "feat(auth)!: migrate to JWT refresh token rotation

BREAKING CHANGE: Old refresh tokens are no longer valid after this update."
```

### Scope

The scope should be the name of the module affected:

- `auth`, `users`, `courses`, `lessons`, `enrollments`, `assignments`, `certificates`, `events`, `notifications`, `uploads`, `health`

---

## Pull Request Process

### Before Submitting

- [ ] Code follows project style guidelines
- [ ] All tests pass (`npm test`)
- [ ] New tests added for new features
- [ ] Documentation updated (if applicable)
- [ ] No console.log or debugging code left in
- [ ] Environment variables documented in `.env.example` (if added)
- [ ] Database migrations tested (if schema changed)

### PR Title Format

Use the same format as commit messages:

```
feat(courses): add course rating system
fix(enrollments): correct progress calculation
```

### PR Description Template

```markdown
## Description
Brief description of what this PR does.

## Related Issues
Closes #123

## Type of Change
- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update

## Testing
Describe the tests you ran and how to reproduce them.

## Screenshots (if applicable)
Add screenshots for UI changes.

## Checklist
- [ ] Code follows style guidelines
- [ ] Self-review completed
- [ ] Tests added/updated
- [ ] Documentation updated
- [ ] No new warnings generated
- [ ] Dependent changes merged
```

### Review Process

1. **Automated checks** — CI pipeline must pass
2. **Code review** — At least one approval from a maintainer
3. **Testing** — Reviewer may test locally
4. **Merge** — Squash and merge to `develop`

### After Merge

```bash
# Clean up your local branch
git checkout develop
git pull upstream develop
git branch -d feature/your-feature-name

# Delete remote branch
git push origin --delete feature/your-feature-name
```

---

## Database Migrations

### Creating a Migration

When you modify the Prisma schema:

```bash
# Create a new migration
npx prisma migrate dev --name add_course_rating

# This will:
# 1. Create a new migration file in prisma/migrations/
# 2. Apply the migration to your local database
# 3. Regenerate the Prisma Client
```

### Migration Best Practices

- **Always test migrations** on a local database first
- **Write descriptive migration names** using snake_case
- **Never edit existing migrations** — create new ones
- **Include both up and down logic** when possible
- **Test rollbacks** to ensure they work

### Applying Migrations

```bash
# Apply all pending migrations
npx prisma migrate deploy

# Reset database (WARNING: destroys all data)
npx prisma migrate reset

# View migration status
npx prisma migrate status
```

### Schema Changes Checklist

- [ ] Update `prisma/schema.prisma`
- [ ] Create migration with descriptive name
- [ ] Test migration locally
- [ ] Update relevant DTOs and entities
- [ ] Update affected services
- [ ] Add/update tests
- [ ] Document breaking changes

---

## Troubleshooting

### Common Issues

#### Database Connection Errors

```bash
# Check PostgreSQL is running
docker-compose ps

# Restart PostgreSQL
docker-compose restart postgres

# Verify connection string in .env.local
echo $DATABASE_URL
```

#### Prisma Client Out of Sync

```bash
# Regenerate Prisma Client
npx prisma generate

# If migrations are out of sync
npx prisma migrate dev
```

#### Redis Connection Errors

```bash
# Check Redis is running
docker-compose ps redis

# Test Redis connection
redis-cli ping
# Should return: PONG
```

#### Port Already in Use

```bash
# Kill process on port 3000
lsof -ti:3000 | xargs kill -9

# Or change PORT in .env.local
PORT=3001
```

#### Module Not Found Errors

```bash
# Clean install dependencies
rm -rf node_modules package-lock.json
npm install
```

### Getting Help

- **GitHub Issues** — Search existing issues or create a new one
- **Discussions** — Ask questions in GitHub Discussions
- **Documentation** — Check README.md and other docs
- **Code Comments** — Look for comments in the codebase

---

## Additional Resources

- [NestJS Documentation](https://docs.nestjs.com/)
- [Prisma Documentation](https://www.prisma.io/docs)
- [Stellar Documentation](https://developers.stellar.org/)
- [Jest Testing Guide](https://jestjs.io/docs/getting-started)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/)

---

## Code of Conduct

Please note that this project follows a Code of Conduct. By participating, you are expected to uphold this code. Please report unacceptable behavior to the project maintainers.

---

## License

By contributing to Hamplard Backend, you agree that your contributions will be licensed under the MIT License.

---

**Thank you for contributing to Hamplard! 🚀**

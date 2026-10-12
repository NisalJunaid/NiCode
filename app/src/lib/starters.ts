/**
 * "New app" starters. Instead of shipping templates that go stale, niCode creates the folder and
 * gives Claude a precise brief to scaffold it with each framework's official tooling.
 */
import type { IconName } from '@/components/ui';

export type Db = 'none' | 'sqlite' | 'postgres' | 'mysql' | 'mongodb';
export type Extra = 'tailwind' | 'auth' | 'docker' | 'tests' | 'lint' | 'ci';

export interface Stack {
  id: string;
  name: string;
  blurb: string;
  icon: IconName;
  /** Official way to create it (guides Claude; it adapts to current versions). */
  create: string;
  /** Offer a JS/TS choice. */
  language?: boolean;
  dbs: Db[];
  extras: Extra[];
}

export const STACKS: Stack[] = [
  { id: 'nextjs', name: 'Next.js', blurb: 'React full-stack web app', icon: 'logo-react', create: 'npx create-next-app@latest (App Router)', language: true, dbs: ['none', 'postgres', 'mysql', 'sqlite', 'mongodb'], extras: ['tailwind', 'auth', 'docker', 'tests', 'lint', 'ci'] },
  { id: 'react-vite', name: 'React + Vite', blurb: 'Single-page web app', icon: 'logo-react', create: 'npm create vite@latest (react template)', language: true, dbs: ['none'], extras: ['tailwind', 'tests', 'lint', 'docker', 'ci'] },
  { id: 'laravel', name: 'Laravel', blurb: 'PHP full-stack framework', icon: 'logo-laravel', create: 'composer create-project laravel/laravel', dbs: ['mysql', 'postgres', 'sqlite', 'none'], extras: ['tailwind', 'auth', 'docker', 'tests', 'ci'] },
  { id: 'express', name: 'Node API', blurb: 'Express / Fastify REST API', icon: 'logo-nodejs', create: 'npm init + Express (or Fastify if asked)', language: true, dbs: ['none', 'postgres', 'mysql', 'sqlite', 'mongodb'], extras: ['auth', 'docker', 'tests', 'lint', 'ci'] },
  { id: 'nestjs', name: 'NestJS', blurb: 'Structured TypeScript backend', icon: 'server-outline', create: 'npx @nestjs/cli new', dbs: ['postgres', 'mysql', 'sqlite', 'mongodb', 'none'], extras: ['auth', 'docker', 'tests', 'ci'] },
  { id: 'expo', name: 'Expo app', blurb: 'React Native mobile app', icon: 'phone-portrait-outline', create: 'npx create-expo-app@latest', dbs: ['none', 'sqlite'], extras: ['tests', 'lint', 'ci'] },
  { id: 'fastapi', name: 'FastAPI', blurb: 'Python async API', icon: 'logo-python', create: 'python venv + fastapi + uvicorn', dbs: ['postgres', 'sqlite', 'mysql', 'mongodb', 'none'], extras: ['auth', 'docker', 'tests', 'lint', 'ci'] },
  { id: 'django', name: 'Django', blurb: 'Python full-stack framework', icon: 'logo-python', create: 'python venv + django-admin startproject', dbs: ['postgres', 'sqlite', 'mysql', 'none'], extras: ['auth', 'docker', 'tests', 'ci'] },
  { id: 'astro', name: 'Astro', blurb: 'Content site / blog', icon: 'rocket-outline', create: 'npm create astro@latest', language: true, dbs: ['none'], extras: ['tailwind', 'lint', 'ci'] },
  { id: 'static', name: 'Static site', blurb: 'Plain HTML, CSS, JS', icon: 'logo-html5', create: 'hand-written files', dbs: ['none'], extras: ['tailwind'] },
  { id: 'blank', name: 'Blank', blurb: 'Empty folder with git', icon: 'folder-open-outline', create: '', dbs: ['none'], extras: [] },
];

export const DB_LABEL: Record<Db, string> = { none: 'No database', sqlite: 'SQLite', postgres: 'PostgreSQL', mysql: 'MySQL', mongodb: 'MongoDB' };
export const EXTRA_LABEL: Record<Extra, string> = {
  tailwind: 'Tailwind CSS',
  auth: 'User login',
  docker: 'Docker',
  tests: 'Tests',
  lint: 'Lint & format',
  ci: 'GitHub Actions CI',
};

export interface StarterChoice {
  name: string;
  stack: Stack;
  language: 'ts' | 'js';
  db: Db;
  extras: Extra[];
  notes: string;
}

export function buildPrompt(c: StarterChoice): string {
  const lines = [
    `Set up a new ${c.stack.name} project in the current folder (\`${c.name}\`, already created and git-initialised, currently empty).`,
    '',
    'Requirements:',
    `- Framework: ${c.stack.name}. Use the official tooling (${c.stack.create}) with the current stable version, run non-interactively, and generate into the current directory (not a subfolder).`,
  ];
  if (c.stack.language) lines.push(`- Language: ${c.language === 'ts' ? 'TypeScript' : 'JavaScript'}.`);
  if (c.db !== 'none') {
    lines.push(
      `- Database: ${DB_LABEL[c.db]}. Configure the framework's usual ORM/driver and environment variables (.env plus a committed .env.example). ` +
        (c.db === 'sqlite'
          ? 'Use a local SQLite file.'
          : `Don't install system packages or create database servers/users without asking me first; if ${DB_LABEL[c.db]} isn't reachable, leave clear placeholders and tell me what to run.`),
    );
  }
  for (const e of c.extras) lines.push(`- ${EXTRA_LABEL[e]}${e === 'auth' ? ' (register / log in / log out, using the framework\'s standard approach)' : ''}.`);
  if (c.notes.trim()) lines.push(`- Also: ${c.notes.trim()}`);
  lines.push(
    '',
    'When done:',
    '- Make sure it builds/starts (run the dev build or tests once) and fix any errors.',
    '- Add a short README with how to run it.',
    '- Make one git commit "Initial scaffold".',
    '- Reply with a brief summary and the command to start it.',
  );
  return lines.join('\n');
}

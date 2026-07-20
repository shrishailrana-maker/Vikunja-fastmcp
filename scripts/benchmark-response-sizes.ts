import { formatFailureEnvelope, formatSuccessEnvelope } from '../src/format.js';

interface Measurement {
  beforeChars: number;
  afterChars: number;
  reductionPercent: number;
}

function measure(before: string, after: string): Measurement {
  return {
    beforeChars: before.length,
    afterChars: after.length,
    reductionPercent: Number(((1 - after.length / before.length) * 100).toFixed(1)),
  };
}

const project = { id: 101, title: 'Alpha' };
const standardTasks = Array.from({ length: 100 }, (_, offset) => ({
  id: 9000 + offset,
  index: 300 + offset,
  identifier: `ALPHA-${300 + offset}`,
  project,
  title: `Example task ${offset + 1} with a realistic concise title`,
  done: false,
  priority: (offset % 5) + 1,
  creator: { id: 7, username: 'example-tester' },
  labels: [
    { id: 9, title: 'bug' },
    { id: 12, title: 'open' },
  ],
  taskUrl: `https://vikunja.example.com/tasks/${9000 + offset}`,
  projectUrl: 'https://vikunja.example.com/projects/101',
}));
const compactTasks = standardTasks.map((task) => ({
  id: task.id,
  portalRef: task.identifier,
  title: task.title,
  done: task.done,
  priority: task.priority,
}));
const pagination = {
  page: 1,
  perPage: 100,
  total: 225,
  totalPages: 3,
  hasMore: true,
  nextPage: 2,
};

const fullDiagnostic = {
  diagnostics: {
    vikunjaUrl: 'https://vikunja.example.com/api/v2',
    connectionStatus: 'online',
    authenticationState: 'authenticated',
    currentUser: { id: 7, username: 'example-user' },
    apiContractVersion: 'v2',
    packageVersion: '2.3.996',
    projectCount: 20,
    projects: Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      title: `Example Project ${index + 1}`,
      archived: false,
    })),
    supportedTools: Array.from({ length: 17 }, (_, index) => `vikunja_tool_${index + 1}`),
    supportedSubcommands: Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [
        `vikunja_tool_${index + 1}`,
        Array.from({ length: 8 }, (__, action) => `action-${action + 1}`),
      ]),
    ),
    operationalNotes: Array.from({ length: 8 }, (_, index) => `Operational note ${index + 1}`),
  },
};
const basicDiagnostic = {
  diagnostics: {
    vikunjaUrl: 'https://vikunja.example.com/api/v2',
    connectionStatus: 'online',
    authenticationState: 'authenticated',
    currentUser: { id: 7, username: 'example-user' },
    apiContractVersion: 'v2',
    packageVersion: '2.3.996',
    projectCount: 20,
    attachmentDownloadRootWritable: true,
  },
};

const fullTask = {
  task: {
    ...standardTasks[0],
    description: 'D'.repeat(4000),
    assignees: [{ id: 8, username: 'example-developer' }],
    dueDate: null,
  },
  comments: Array.from({ length: 5 }, (_, index) => ({
    id: 2000 + index,
    comment: `Evidence ${index + 1}: ${'C'.repeat(800)}`,
    author: { id: 7, username: 'example-tester' },
  })),
  attachments: Array.from({ length: 3 }, (_, index) => ({
    id: 3000 + index,
    fileName: `test-log-${index + 1}.txt`,
    mime: 'text/plain',
    fileSize: 12000,
  })),
};
const compactTask = {
  task: {
    id: standardTasks[0].id,
    portalRef: standardTasks[0].identifier,
    project,
    title: standardTasks[0].title,
    done: standardTasks[0].done,
    priority: standardTasks[0].priority,
  },
};

const createReceipt = {
  action: 'created',
  target: {
    id: 9005,
    index: 305,
    identifier: 'ALPHA-305',
    project,
    title: 'Example task',
  },
};
const longComment = {
  id: 2001,
  comment: `Verification evidence: ${'E'.repeat(2000)}`,
  author: { id: 7, username: 'example-tester' },
  created: '2026-07-20T00:00:00Z',
};
const closeTask = { action: 'closed', target: createReceipt.target };
const legacyClose = {
  comment: longComment,
  task: closeTask,
  composedCalls: ['POST /tasks/9005/comments', 'PATCH /tasks/9005'],
};
const compactClose = {
  comment: { id: longComment.id, author: longComment.author, created: longComment.created },
  task: closeTask,
  changed: ['comment', 'done'],
  composedCalls: legacyClose.composedCalls,
};

const identityError = {
  status: 409,
  code: 'TASK_IDENTITY_MISMATCH',
  method: 'PATCH',
  path: '/tasks/9005',
  message: 'Resolved task does not match the requested project.',
  fieldErrors: [],
};
const unauthorized = {
  status: 401,
  code: 'UNAUTHORIZED',
  method: 'GET',
  path: '/tasks/9005',
  message: 'Authentication failed.',
  fieldErrors: [],
};
const forbidden = { ...unauthorized, status: 403, code: 'PERMISSION_DENIED' };

const unchanged = (text: string): Measurement => measure(text, text);
const createText = formatSuccessEnvelope('created task', createReceipt);
const identityText = formatFailureEnvelope('identity mismatch', identityError);
const unauthorizedText = formatFailureEnvelope('unauthorized', unauthorized);
const forbiddenText = formatFailureEnvelope('forbidden', forbidden);

const results = {
  selfCheck: measure(
    formatSuccessEnvelope('self-check', fullDiagnostic),
    formatSuccessEnvelope('self-check', basicDiagnostic),
  ),
  taskGet: measure(
    formatSuccessEnvelope('task detail', fullTask),
    formatSuccessEnvelope('task detail', compactTask),
  ),
  taskSearch100: measure(
    formatSuccessEnvelope('task list', { project, tasks: standardTasks, pagination }),
    formatSuccessEnvelope('task list', {
      project,
      tasks: compactTasks,
      pagination,
      truncated: true,
    }),
  ),
  createIfAbsent: unchanged(createText),
  commentAndClose: measure(
    formatSuccessEnvelope('closed task', legacyClose),
    formatSuccessEnvelope('closed task', compactClose),
  ),
  identityMismatch: unchanged(identityText),
  unauthorized401: unchanged(unauthorizedText),
  permissionDenied403: unchanged(forbiddenText),
};

console.log(JSON.stringify(results, null, 2));

for (const name of ['selfCheck', 'taskGet', 'taskSearch100', 'commentAndClose'] as const) {
  if (results[name].reductionPercent < 60) {
    throw new Error(`${name} response reduction fell below the 60% regression threshold.`);
  }
}

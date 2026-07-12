import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { VikunjaApiClient } from './api.js';
import { createTask } from './tasks.js';
import { VikunjaError } from './errors.js';

function templateError(status: number, code: string, message: string): VikunjaError {
  return new VikunjaError({
    status,
    code,
    method: 'TEMPLATE_STORE',
    path: 'templates',
    message,
    fieldErrors: [],
  });
}

export interface StoredTemplate {
  id: string;
  name: string;
  fields: { title: string; description?: string; priority?: number; dueDate?: string | null };
}

export class TemplateStore {
  constructor(
    public readonly filePath = process.env.VIKUNJA_TEMPLATE_FILE ||
      path.join(os.homedir(), '.vikunja-fastmcp', 'templates.json'),
  ) {}

  private async read(): Promise<StoredTemplate[]> {
    try {
      const value = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      return Array.isArray(value) ? value : [];
    } catch (error: any) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  private async write(templates: StoredTemplate[]) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(templates, null, 2));
    await fs.rename(temporary, this.filePath);
  }

  async create(name: string, fields: StoredTemplate['fields']) {
    const templates = await this.read();
    if (templates.some((item) => item.name.toLowerCase() === name.toLowerCase()))
      throw templateError(409, 'TEMPLATE_ALREADY_EXISTS', `Template "${name}" already exists.`);
    const template = { id: crypto.randomUUID(), name, fields };
    await this.write([...templates, template]);
    return template;
  }

  async list() {
    return this.read();
  }

  async get(idOrName: string) {
    const template = (await this.read()).find(
      (item) => item.id === idOrName || item.name.toLowerCase() === idOrName.toLowerCase(),
    );
    if (!template)
      throw templateError(404, 'TEMPLATE_NOT_FOUND', `Template "${idOrName}" was not found.`);
    return template;
  }

  async delete(idOrName: string) {
    const templates = await this.read();
    const remaining = templates.filter(
      (item) => item.id !== idOrName && item.name.toLowerCase() !== idOrName.toLowerCase(),
    );
    if (remaining.length === templates.length)
      throw templateError(404, 'TEMPLATE_NOT_FOUND', `Template "${idOrName}" was not found.`);
    await this.write(remaining);
    return { deleted: true, template: idOrName };
  }
}

function substitute(value: string | undefined, variables: Record<string, string>) {
  return value?.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_, key) => variables[key] ?? `{{${key}}}`);
}

export async function instantiateTemplate(
  client: VikunjaApiClient,
  store: TemplateStore,
  idOrName: string,
  project: { id?: number; title?: string },
  variables: Record<string, string> = {},
) {
  const template = await store.get(idOrName);
  return createTask(client, project, {
    ...template.fields,
    title: substitute(template.fields.title, variables)!,
    description: substitute(template.fields.description, variables),
  });
}

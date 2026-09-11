/** Validates the pinned MCP primitive form grammar before offering any acceptance. */
import type {
  ElicitationFieldDto,
  ElicitationOptionDto,
  InteractionPresentationDto,
} from './dto/interaction.dto';
import { nonempty, onlyKeys, record } from './request-validation';

/** Converts only finite, unambiguous enum options; duplicate values are invalid. */
function enumOptions(
  schema: Record<string, unknown>,
): ElicitationOptionDto[] | null {
  let options: ElicitationOptionDto[];
  if (
    Array.isArray(schema.enum) &&
    schema.enum.every((v) => typeof v === 'string')
  ) {
    const names = schema.enumNames;
    if (
      names !== undefined &&
      (!Array.isArray(names) ||
        names.length !== schema.enum.length ||
        !names.every((v) => typeof v === 'string'))
    )
      return null;
    options = schema.enum.map((value, i) => ({
      value,
      label: Array.isArray(names) ? String(names[i]) : value,
    }));
  } else {
    const variants = schema.oneOf ?? schema.anyOf;
    if (!Array.isArray(variants)) return null;
    options = [];
    for (const raw of variants) {
      const option = record(raw);
      if (
        !option ||
        !onlyKeys(option, ['const', 'title']) ||
        typeof option.const !== 'string' ||
        typeof option.title !== 'string'
      )
        return null;
      options.push({ value: option.const, label: option.title });
    }
  }
  return options.length > 0 &&
    new Set(options.map((o) => o.value)).size === options.length
    ? options
    : null;
}

/** Parses one field without dropping unknown validation or semantic keywords. */
function parseField(
  name: string,
  value: unknown,
  required: boolean,
): ElicitationFieldDto | null {
  const schema = record(value);
  if (
    !schema ||
    !onlyKeys(schema, [
      'type',
      'title',
      'description',
      'default',
      'enum',
      'enumNames',
      'oneOf',
      'items',
      'minimum',
      'maximum',
      'minLength',
      'maxLength',
      'minItems',
      'maxItems',
      'format',
    ])
  )
    return null;
  if (
    (schema.title !== undefined && typeof schema.title !== 'string') ||
    (schema.description !== undefined && typeof schema.description !== 'string')
  )
    return null;
  const field: ElicitationFieldDto = {
    name,
    title: typeof schema.title === 'string' ? schema.title : name,
    description:
      typeof schema.description === 'string' ? schema.description : '',
    type: schema.type as ElicitationFieldDto['type'],
    required,
  };
  const common = ['type', 'title', 'description', 'default'];
  if (schema.type === 'string') {
    if ('enum' in schema || 'oneOf' in schema) {
      if (
        !onlyKeys(schema, [...common, 'enum', 'enumNames', 'oneOf']) ||
        ('enum' in schema && 'oneOf' in schema)
      )
        return null;
      const options = enumOptions(schema);
      if (!options) return null;
      field.type = 'enum';
      field.options = options;
    } else {
      if (!onlyKeys(schema, [...common, 'minLength', 'maxLength', 'format']))
        return null;
      if (
        schema.format !== undefined &&
        (typeof schema.format !== 'string' ||
          !['email', 'uri', 'date', 'date-time'].includes(schema.format))
      )
        return null;
      if (typeof schema.format === 'string') field.format = schema.format;
    }
  } else if (schema.type === 'array') {
    if (!onlyKeys(schema, [...common, 'items', 'minItems', 'maxItems']))
      return null;
    const items = record(schema.items);
    if (
      !items ||
      !onlyKeys(items, ['type', 'enum', 'anyOf']) ||
      ('enum' in items
        ? items.type !== 'string' || 'anyOf' in items
        : 'type' in items)
    )
      return null;
    const options = enumOptions(items);
    if (!options) return null;
    field.options = options;
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (!onlyKeys(schema, [...common, 'minimum', 'maximum'])) return null;
  } else if (schema.type === 'boolean') {
    if (!onlyKeys(schema, common)) return null;
  } else return null;
  for (const key of [
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
  ] as const) {
    const bound = schema[key];
    if (bound === undefined) continue;
    if (
      typeof bound !== 'number' ||
      !Number.isFinite(bound) ||
      (!['minimum', 'maximum'].includes(key) &&
        (!Number.isSafeInteger(bound) || bound < 0))
    )
      return null;
    field[key] = bound;
  }
  for (const [min, max] of [
    [field.minimum, field.maximum],
    [field.minLength, field.maxLength],
    [field.minItems, field.maxItems],
  ]) {
    if (min !== undefined && max !== undefined && min > max) return null;
  }
  if (schema.default !== undefined && !validFieldValue(field, schema.default))
    return null;
  return field;
}

/** Parses the entire form or none of it, including extended OpenAI form modes. */
function parseForm(value: unknown): ElicitationFieldDto[] | null {
  const schema = record(value);
  if (
    !schema ||
    schema.type !== 'object' ||
    !onlyKeys(schema, ['$schema', 'type', 'properties', 'required'])
  )
    return null;
  if (schema.$schema !== undefined && typeof schema.$schema !== 'string')
    return null;
  const properties = record(schema.properties);
  if (
    !properties ||
    (schema.required !== undefined &&
      (!Array.isArray(schema.required) ||
        !schema.required.every(
          (v) => typeof v === 'string' && Object.hasOwn(properties, v),
        )))
  )
    return null;
  const required = new Set(
    Array.isArray(schema.required) ? (schema.required as string[]) : [],
  );
  const fields: ElicitationFieldDto[] = [];
  for (const [name, value] of Object.entries(properties)) {
    const field = parseField(name, value, required.has(name));
    if (!field) return null;
    fields.push(field);
  }
  return fields;
}

/** Allows explicit browser navigation only to HTTP(S), never executable URL schemes. */
function browserUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? value
      : null;
  } catch {
    return null;
  }
}

/** Builds a whole supported form/URL or a visible Decline/Cancel-only interaction. */
export function presentElicitation(
  params: Record<string, unknown>,
): InteractionPresentationDto {
  const isForm = ['form', 'openaiForm', 'openai/form'].includes(
    String(params.mode),
  );
  const fields = isForm ? parseForm(params.requestedSchema) : null;
  const url =
    params.mode === 'url' && nonempty(params.elicitationId)
      ? browserUrl(params.url)
      : null;
  const supported = fields !== null || url !== null;
  return {
    kind: 'elicitation',
    supported,
    unsupportedReason: supported
      ? null
      : 'This client cannot render this complete request. Only Decline or Cancel is available.',
    message: typeof params.message === 'string' ? params.message : '',
    serverName:
      typeof params.serverName === 'string' ? params.serverName : null,
    cwd: null,
    environmentId: null,
    url,
    fields: fields ?? [],
    permissions: [],
  };
}

/** Applies the understood primitive constraints at the authoritative response boundary. */
function validFieldValue(field: ElicitationFieldDto, value: unknown): boolean {
  if (field.type === 'boolean') return typeof value === 'boolean';
  if (field.type === 'number' || field.type === 'integer')
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      (field.type !== 'integer' || Number.isInteger(value)) &&
      (field.minimum === undefined || value >= field.minimum) &&
      (field.maximum === undefined || value <= field.maximum)
    );
  if (field.type === 'enum')
    return (
      typeof value === 'string' &&
      !!field.options?.some((option) => option.value === value)
    );
  if (field.type === 'array')
    return (
      Array.isArray(value) &&
      new Set(value).size === value.length &&
      value.every(
        (v: unknown) =>
          typeof v === 'string' && field.options?.some((o) => o.value === v),
      ) &&
      (field.minItems === undefined || value.length >= field.minItems) &&
      (field.maxItems === undefined || value.length <= field.maxItems)
    );
  if (typeof value !== 'string') return false;
  const length = [...value].length;
  if (
    (field.minLength !== undefined && length < field.minLength) ||
    (field.maxLength !== undefined && length > field.maxLength)
  )
    return false;
  if (field.format === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (field.format === 'uri') {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }
  if (field.format === 'date')
    return (
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString().startsWith(value)
    );
  if (field.format === 'date-time')
    return (
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(
        value,
      ) && !Number.isNaN(Date.parse(value))
    );
  return true;
}

/** Encodes known negative actions even when form semantics are unsupported. */
export function encodeElicitation(
  params: Record<string, unknown>,
  value: unknown,
): unknown {
  const response = record(value);
  if (
    !response ||
    !onlyKeys(response, ['action', 'content']) ||
    !['accept', 'decline', 'cancel'].includes(String(response.action))
  )
    throw new Error('Invalid elicitation response');
  if (response.action !== 'accept') {
    if (response.content !== null)
      throw new Error('Decline and Cancel must not include form contents');
    return { action: response.action, content: null, _meta: null };
  }
  const prompt = presentElicitation(params);
  if (!prompt.supported)
    throw new Error('Cannot accept unsupported elicitation semantics');
  if (prompt.url) {
    if (response.content !== null)
      throw new Error('URL elicitation must not include form contents');
    return { action: 'accept', content: null, _meta: null };
  }
  const content = record(response.content);
  if (
    !content ||
    !onlyKeys(
      content,
      prompt.fields.map((f) => f.name),
    )
  )
    throw new Error('Invalid elicitation content');
  for (const field of prompt.fields) {
    if (!Object.hasOwn(content, field.name)) {
      if (field.required)
        throw new Error('A required elicitation answer is missing');
    } else if (!validFieldValue(field, content[field.name]))
      throw new Error('An elicitation answer does not match its schema');
  }
  return { action: 'accept', content, _meta: null };
}

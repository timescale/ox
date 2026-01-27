import { describe, expect, test } from 'bun:test';
import {
  AGENT_INFO,
  AGENT_INFO_MAP,
  AGENT_SELECT_OPTIONS,
  AGENTS,
  CLAUDE_MODELS,
  DEFAULT_AGENT,
  getModelsForAgent,
  openCodeIdToModel,
} from './agents';

describe('openCodeIdToModel', () => {
  test('parses model with provider prefix', () => {
    const model = openCodeIdToModel('anthropic/claude-3-sonnet');
    expect(model).toEqual({
      id: 'anthropic/claude-3-sonnet',
      name: 'claude-3-sonnet',
      description: 'anthropic',
    });
  });

  test('parses model with openai prefix', () => {
    const model = openCodeIdToModel('openai/gpt-4-turbo');
    expect(model).toEqual({
      id: 'openai/gpt-4-turbo',
      name: 'gpt-4-turbo',
      description: 'openai',
    });
  });

  test('handles model without provider prefix', () => {
    const model = openCodeIdToModel('local-model');
    expect(model).toEqual({
      id: 'local-model',
      name: 'local-model',
      description: 'local-model',
    });
  });

  test('handles model with multiple slashes (only first part used as description)', () => {
    const model = openCodeIdToModel('provider/model/variant');
    // Note: only first split part is used, so 'variant' is lost in the name
    expect(model).toEqual({
      id: 'provider/model/variant',
      name: 'model',
      description: 'provider',
    });
  });

  test('handles empty string', () => {
    const model = openCodeIdToModel('');
    expect(model).toEqual({
      id: '',
      name: '',
      description: '',
    });
  });
});

describe('CLAUDE_MODELS', () => {
  test('contains expected models', () => {
    expect(CLAUDE_MODELS).toHaveLength(3);

    const modelIds = CLAUDE_MODELS.map((m) => m.id);
    expect(modelIds).toContain('haiku');
    expect(modelIds).toContain('sonnet');
    expect(modelIds).toContain('opus');
  });

  test('all models have required fields', () => {
    for (const model of CLAUDE_MODELS) {
      expect(model.id).toBeDefined();
      expect(typeof model.id).toBe('string');
      expect(model.name).toBeDefined();
      expect(typeof model.name).toBe('string');
      expect(model.description).toBeDefined();
      expect(typeof model.description).toBe('string');
    }
  });
});

describe('AGENT_INFO', () => {
  test('contains opencode and claude agents', () => {
    expect(AGENT_INFO).toHaveLength(2);

    const agentIds = AGENT_INFO.map((a) => a.id);
    expect(agentIds).toContain('opencode');
    expect(agentIds).toContain('claude');
  });

  test('all agents have required fields', () => {
    for (const agent of AGENT_INFO) {
      expect(agent.id).toBeDefined();
      expect(agent.name).toBeDefined();
      expect(agent.color).toBeDefined();
      expect(agent.description).toBeDefined();
    }
  });

  test('agent colors are valid hex colors', () => {
    for (const agent of AGENT_INFO) {
      expect(agent.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});

describe('AGENTS', () => {
  test('contains all agent ids', () => {
    expect(AGENTS).toContain('opencode');
    expect(AGENTS).toContain('claude');
  });

  test('matches AGENT_INFO ids', () => {
    const infoIds = AGENT_INFO.map((a) => a.id);
    expect(AGENTS).toEqual(infoIds);
  });
});

describe('DEFAULT_AGENT', () => {
  test('is a valid agent', () => {
    expect(AGENTS).toContain(DEFAULT_AGENT);
  });

  test('is opencode', () => {
    expect(DEFAULT_AGENT).toBe('opencode');
  });
});

describe('AGENT_SELECT_OPTIONS', () => {
  test('contains options for all agents', () => {
    expect(AGENT_SELECT_OPTIONS).toHaveLength(2);
  });

  test('options have correct structure', () => {
    for (const option of AGENT_SELECT_OPTIONS) {
      expect(option.name).toBeDefined();
      expect(option.value).toBeDefined();
      expect(option.description).toBeDefined();
    }
  });

  test('option values match agent ids', () => {
    const optionValues = AGENT_SELECT_OPTIONS.map((o) => o.value);
    expect(optionValues).toContain('opencode');
    expect(optionValues).toContain('claude');
  });
});

describe('AGENT_INFO_MAP', () => {
  test('contains entries for all agents', () => {
    expect(AGENT_INFO_MAP.opencode).toBeDefined();
    expect(AGENT_INFO_MAP.claude).toBeDefined();
  });

  test('entries match AGENT_INFO', () => {
    for (const agent of AGENT_INFO) {
      expect(AGENT_INFO_MAP[agent.id]).toEqual(agent);
    }
  });
});

describe('getModelsForAgent', () => {
  test('returns CLAUDE_MODELS for claude agent', async () => {
    const models = await getModelsForAgent('claude');
    expect(models).toBe(CLAUDE_MODELS);
  });

  // Note: We can't easily test opencode models without Docker
  // so we just test that it returns an array (possibly empty)
  test('returns array for opencode agent', async () => {
    const models = await getModelsForAgent('opencode');
    expect(Array.isArray(models)).toBe(true);
  });
});

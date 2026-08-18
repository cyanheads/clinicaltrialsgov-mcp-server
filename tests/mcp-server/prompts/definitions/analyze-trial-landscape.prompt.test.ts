/**
 * @fileoverview Tests for analyze_trial_landscape prompt.
 * @module tests/mcp-server/prompts/definitions/analyze-trial-landscape.prompt
 */

import { describe, expect, it } from 'vitest';
import { analyzeTrialLandscape } from '@/mcp-server/prompts/definitions/analyze-trial-landscape.prompt.js';

type PromptMessage = { role: string; content: { type: string; text: string } };
const argsSchema = analyzeTrialLandscape.args!;
const generate = (args: Parameters<typeof analyzeTrialLandscape.generate>[0]) =>
  analyzeTrialLandscape.generate(args) as PromptMessage[];
const firstMessage = (
  args: Parameters<typeof analyzeTrialLandscape.generate>[0],
): PromptMessage => {
  const [msg] = generate(args);
  if (!msg) throw new Error('generate() returned no messages');
  return msg;
};

describe('analyzeTrialLandscape', () => {
  describe('args validation', () => {
    it('requires topic', () => {
      expect(() => argsSchema.parse({})).toThrow();
    });

    it('rejects an empty topic — the schema advertises minLength 1 (#99)', () => {
      expect(() => argsSchema.parse({ topic: '' })).toThrow();
    });

    it('leaves topic optionality untouched — no default is introduced (#99)', () => {
      // A Zod `.default()` would advertise topic as required: true in
      // prompts/list for the wrong reason; it is required on its own merits.
      expect(argsSchema.parse({ topic: 'Lung Cancer' }).topic).toBe('Lung Cancer');
      expect(() => argsSchema.parse({})).toThrow();
    });

    it('accepts topic only', () => {
      const args = argsSchema.parse({ topic: 'Lung Cancer' });
      expect(args.topic).toBe('Lung Cancer');
      expect(args.focusAreas).toBeUndefined();
    });

    it('accepts topic with focusAreas as comma-separated string', () => {
      const args = argsSchema.parse({
        topic: 'Diabetes',
        focusAreas: 'status, phases, sponsors',
      });
      expect(args.focusAreas).toBe('status, phases, sponsors');
    });

    it('accepts empty focusAreas string', () => {
      const args = argsSchema.parse({
        topic: 'Test',
        focusAreas: '',
      });
      expect(args.focusAreas).toBe('');
    });

    it('rejects array focusAreas (MCP spec requires strings on the wire)', () => {
      expect(() =>
        argsSchema.parse({
          topic: 'Diabetes',
          focusAreas: ['status', 'phases'],
        }),
      ).toThrow();
    });
  });

  describe('generate', () => {
    it('returns a single user message', () => {
      const messages = generate({ topic: 'Lung Cancer' });
      expect(messages).toHaveLength(1);
      expect(firstMessage({ topic: 'Lung Cancer' }).role).toBe('user');
    });

    it('includes the topic in the message', () => {
      expect(firstMessage({ topic: 'Type 2 Diabetes' }).content.text).toContain('Type 2 Diabetes');
    });

    it('mentions available tools', () => {
      const text = firstMessage({ topic: 'Test' }).content.text;
      expect(text).toContain('clinicaltrials_get_study_count');
      expect(text).toContain('clinicaltrials_search_studies');
      expect(text).toContain('clinicaltrials_get_field_values');
    });

    it('uses default focus when focusAreas omitted', () => {
      expect(firstMessage({ topic: 'Test' }).content.text).toContain(
        'whatever dimensions seem most informative',
      );
    });

    it('uses default focus for empty focusAreas', () => {
      expect(firstMessage({ topic: 'Test', focusAreas: '' }).content.text).toContain(
        'whatever dimensions seem most informative',
      );
    });

    it('includes specific focus areas when provided', () => {
      const text = firstMessage({ topic: 'Cancer', focusAreas: 'sponsors, geography' }).content
        .text;
      expect(text).toContain('sponsors, geography');
      expect(text).not.toContain('whatever dimensions');
    });

    it('trims whitespace around comma-separated focusAreas', () => {
      const text = firstMessage({ topic: 'Cancer', focusAreas: 'sponsors,   geography , phases' })
        .content.text;
      expect(text).toContain('sponsors, geography, phases');
    });

    it('returns content with type text', () => {
      expect(firstMessage({ topic: 'Test' }).content.type).toBe('text');
    });

    it('throws for a whitespace-only topic the schema cannot catch (#99)', () => {
      // `.min(1)` passes for '   '; the trim check inside generate() closes it.
      expect(() => generate({ topic: '   ' })).toThrow(/topic/);
    });

    it('renders a non-blank topic unchanged', () => {
      expect(firstMessage({ topic: ' Lung Cancer ' }).content.text).toContain('Lung Cancer');
    });
  });

  describe('metadata', () => {
    it('has description', () => {
      expect(analyzeTrialLandscape.description).toBeTruthy();
    });
  });
});

/**
 * @fileoverview Tests for analyze_trial_landscape prompt.
 * @module tests/mcp-server/prompts/definitions/analyze-trial-landscape.prompt
 */

import { describe, expect, it } from 'vitest';
import { analyzeTrialLandscape } from '@/mcp-server/prompts/definitions/analyze-trial-landscape.prompt.js';

describe('analyzeTrialLandscape', () => {
  describe('args validation', () => {
    it('requires topic', () => {
      expect(() => analyzeTrialLandscape.args.parse({})).toThrow();
    });

    it('accepts topic only', () => {
      const args = analyzeTrialLandscape.args.parse({ topic: 'Lung Cancer' });
      expect(args.topic).toBe('Lung Cancer');
      expect(args.focusAreas).toBeUndefined();
    });

    it('accepts topic with focusAreas', () => {
      const args = analyzeTrialLandscape.args.parse({
        topic: 'Diabetes',
        focusAreas: ['status', 'phases', 'sponsors'],
      });
      expect(args.focusAreas).toEqual(['status', 'phases', 'sponsors']);
    });

    it('accepts empty focusAreas array', () => {
      const args = analyzeTrialLandscape.args.parse({
        topic: 'Test',
        focusAreas: [],
      });
      expect(args.focusAreas).toEqual([]);
    });
  });

  describe('generate', () => {
    it('returns a single user message', () => {
      const messages = analyzeTrialLandscape.generate({ topic: 'Lung Cancer' });
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('user');
    });

    it('includes the topic in the message', () => {
      const messages = analyzeTrialLandscape.generate({ topic: 'Type 2 Diabetes' });
      const text = (messages[0].content as { type: string; text: string }).text;
      expect(text).toContain('Type 2 Diabetes');
    });

    it('mentions available tools', () => {
      const messages = analyzeTrialLandscape.generate({ topic: 'Test' });
      const text = (messages[0].content as { type: string; text: string }).text;
      expect(text).toContain('clinicaltrials_get_study_count');
      expect(text).toContain('clinicaltrials_search_studies');
      expect(text).toContain('clinicaltrials_get_field_values');
    });

    it('uses default focus when focusAreas omitted', () => {
      const messages = analyzeTrialLandscape.generate({ topic: 'Test' });
      const text = (messages[0].content as { type: string; text: string }).text;
      expect(text).toContain('whatever dimensions seem most informative');
    });

    it('uses default focus for empty focusAreas', () => {
      const messages = analyzeTrialLandscape.generate({ topic: 'Test', focusAreas: [] });
      const text = (messages[0].content as { type: string; text: string }).text;
      expect(text).toContain('whatever dimensions seem most informative');
    });

    it('includes specific focus areas when provided', () => {
      const messages = analyzeTrialLandscape.generate({
        topic: 'Cancer',
        focusAreas: ['sponsors', 'geography'],
      });
      const text = (messages[0].content as { type: string; text: string }).text;
      expect(text).toContain('sponsors, geography');
      expect(text).not.toContain('whatever dimensions');
    });

    it('returns content with type text', () => {
      const messages = analyzeTrialLandscape.generate({ topic: 'Test' });
      const content = messages[0].content as { type: string; text: string };
      expect(content.type).toBe('text');
    });
  });

  describe('metadata', () => {
    it('has description', () => {
      expect(analyzeTrialLandscape.description).toBeTruthy();
    });
  });
});

import { describe, it, expect } from 'vitest';
import {
  CATEGORY_REGEX,
  isValidCategoryFormat,
  normalizeCategory,
  validateCategoryOrNull,
} from '../utils/categoryValidation';

describe('categoryValidation', () => {
  describe('CATEGORY_REGEX shape', () => {
    it('accepte les 22 valeurs en prod (Apr 19 2026)', () => {
      const prodCategories = [
        'data', 'guides', 'ai/text', 'tools', 'ai', 'data/science',
        'data/finance', 'data/government', 'bitcoin', 'data/health',
        'ai/code', 'social', 'media', 'data/networking', 'tools/testing',
        'tools/search', 'data/reference', 'data/media', 'data/location',
        'data/environment', 'data/developer', 'ai/content',
      ];
      for (const c of prodCategories) {
        expect(CATEGORY_REGEX.test(c)).toBe(true);
      }
    });

    it('accepte les hyphens et underscores', () => {
      expect(isValidCategoryFormat('weather-api')).toBe(true);
      expect(isValidCategoryFormat('llm_completion')).toBe(true);
    });

    it('rejette les valeurs trop courtes (1 char)', () => {
      expect(isValidCategoryFormat('a')).toBe(false);
    });

    it('rejette les valeurs trop longues (>32 chars)', () => {
      expect(isValidCategoryFormat('a'.repeat(33))).toBe(false);
      expect(isValidCategoryFormat('a'.repeat(32))).toBe(true);
    });

    it('rejette les caractères interdits (espaces, majuscules, symboles)', () => {
      expect(isValidCategoryFormat('Data')).toBe(false);
      expect(isValidCategoryFormat('weather api')).toBe(false);
      expect(isValidCategoryFormat('data!')).toBe(false);
      expect(isValidCategoryFormat('data.finance')).toBe(false);
      expect(isValidCategoryFormat('émoji')).toBe(false);
    });

    it('exige que le premier caractère soit une lettre', () => {
      expect(isValidCategoryFormat('1data')).toBe(false);
      expect(isValidCategoryFormat('/data')).toBe(false);
      expect(isValidCategoryFormat('-data')).toBe(false);
    });
  });

  describe('normalizeCategory', () => {
    it('trim et lowercase', () => {
      expect(normalizeCategory('  Data  ')).toBe('data');
      expect(normalizeCategory('AI/TEXT')).toBe('ai/text');
    });

    it('applique les alias historiques', () => {
      expect(normalizeCategory('ai/ml')).toBe('ai');
      expect(normalizeCategory('lightning')).toBe('bitcoin');
      expect(normalizeCategory('real-time-data')).toBe('data');
    });

    it('retourne null pour input absent ou vide', () => {
      expect(normalizeCategory(undefined)).toBeNull();
      expect(normalizeCategory(null)).toBeNull();
      expect(normalizeCategory('')).toBeNull();
      expect(normalizeCategory('   ')).toBeNull();
    });

    it('ne valide pas le format (retourne la string même si mauvaise)', () => {
      // normalizeCategory est pure normalisation, pas validation.
      expect(normalizeCategory('BAD CATEGORY!')).toBe('bad category!');
    });
  });

  describe('validateCategoryOrNull', () => {
    it('retourne la forme canonique pour les valeurs valides', () => {
      expect(validateCategoryOrNull('data')).toBe('data');
      expect(validateCategoryOrNull('  DATA/FINANCE  ')).toBe('data/finance');
      expect(validateCategoryOrNull('ai/ml')).toBe('ai'); // alias
    });

    it('retourne null pour les valeurs invalides', () => {
      expect(validateCategoryOrNull('a')).toBeNull(); // trop court
      expect(validateCategoryOrNull('foo bar')).toBeNull(); // espace
      expect(validateCategoryOrNull('1data')).toBeNull(); // commence par chiffre
      expect(validateCategoryOrNull(undefined)).toBeNull();
      expect(validateCategoryOrNull('')).toBeNull();
    });
  });
});

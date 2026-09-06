import zhHansCatalogue from "./locales/zh-Hans.json";
import zhHantCatalogue from "./locales/zh-Hant.json";
import csCatalogue from "./locales/cs.json";
import daCatalogue from "./locales/da.json";
import nlCatalogue from "./locales/nl.json";
import enCatalogue from "./locales/en.json";
import fiCatalogue from "./locales/fi.json";
import frCatalogue from "./locales/fr.json";
import deCatalogue from "./locales/de.json";
import itCatalogue from "./locales/it.json";
import jaCatalogue from "./locales/ja.json";
import koCatalogue from "./locales/ko.json";
import nbCatalogue from "./locales/nb.json";
import plCatalogue from "./locales/pl.json";
import ptBRCatalogue from "./locales/pt-BR.json";
import ptPTCatalogue from "./locales/pt-PT.json";
import esCatalogue from "./locales/es.json";
import svCatalogue from "./locales/sv.json";
import thCatalogue from "./locales/th.json";
import trCatalogue from "./locales/tr.json";

export const SUPPORTED_ADMIN_LOCALE_METADATA = [
  ["zh-Hans", "ltr"],
  ["zh-Hant", "ltr"],
  ["cs", "ltr"],
  ["da", "ltr"],
  ["nl", "ltr"],
  ["en", "ltr"],
  ["fi", "ltr"],
  ["fr", "ltr"],
  ["de", "ltr"],
  ["it", "ltr"],
  ["ja", "ltr"],
  ["ko", "ltr"],
  ["nb", "ltr"],
  ["pl", "ltr"],
  ["pt-BR", "ltr"],
  ["pt-PT", "ltr"],
  ["es", "ltr"],
  ["sv", "ltr"],
  ["th", "ltr"],
  ["tr", "ltr"],
];

export const SUPPORTED_ADMIN_LOCALES = SUPPORTED_ADMIN_LOCALE_METADATA.map(([locale]) => locale);
export const CATALOGUE_KEYS = Object.keys(enCatalogue);

export const sourceCatalogues = {
  "zh-Hans": zhHansCatalogue,
  "zh-Hant": zhHantCatalogue,
  cs: csCatalogue,
  da: daCatalogue,
  nl: nlCatalogue,
  en: enCatalogue,
  fi: fiCatalogue,
  fr: frCatalogue,
  de: deCatalogue,
  it: itCatalogue,
  ja: jaCatalogue,
  ko: koCatalogue,
  nb: nbCatalogue,
  pl: plCatalogue,
  "pt-BR": ptBRCatalogue,
  "pt-PT": ptPTCatalogue,
  es: esCatalogue,
  sv: svCatalogue,
  th: thCatalogue,
  tr: trCatalogue,
};

export const catalogues = sourceCatalogues;

module.exports = {
  i18n: {
    defaultLocale: 'da',
    locales: [
      "bn",
      "de",
      "en",
      "da",
      "es",
      "fr",
      "he",
      "id",
      "it",
      "ja",
      "ko",
      "pl",
      "pt",
      "ru",
      "ro",      
      "sv",
      "te",
      "vi",
      "zh",
      "ar",
      "tr",
      "ca",
      "fi",
    ],
  },
  localePath:
    typeof window === 'undefined'
      ? require('path').resolve('./public/locales')
      : '/public/locales',
};

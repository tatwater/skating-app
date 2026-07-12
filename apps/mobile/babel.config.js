module.exports = (api) => {
  api.cache(true)
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      // Tamagui's optimizing compiler (D7) — flattens/extracts styles at build time.
      [
        '@tamagui/babel-plugin',
        {
          components: ['tamagui'],
          config: './tamagui.config.ts',
          logTimings: true,
          disableExtraction: process.env.NODE_ENV === 'development',
        },
      ],
      // react-native-reanimated 4 ships its worklets plugin here; it MUST be last.
      'react-native-worklets/plugin',
    ],
  }
}

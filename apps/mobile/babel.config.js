module.exports = (api) => {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // react-native-reanimated 4 ships its worklets plugin here; it MUST be last.
    plugins: ['react-native-worklets/plugin'],
  };
};

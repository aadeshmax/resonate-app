const { withGradleProperties } = require('expo/config-plugins');

module.exports = function withDisableNewArch(config) {
  return withGradleProperties(config, (config) => {
    config.modResults = config.modResults.filter(
      (item) => item.key !== 'newArchEnabled'
    );
    config.modResults.push({
      type: 'property',
      key: 'newArchEnabled',
      value: 'false',
    });
    return config;
  });
};

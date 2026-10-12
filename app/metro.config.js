// Lets the app import the shared wire contract from ../protocol (outside the app folder).
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, '../protocol')];
module.exports = config;

const { registerStartHandler } = require('./start');
const { registerUrlHandlers } = require('./url');
const { registerCommandHandlers } = require('./commands');

module.exports = {
  registerStartHandler,
  registerUrlHandlers,
  registerCommandHandlers,
};

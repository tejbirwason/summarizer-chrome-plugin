// Helper to extract functions from background.js for testing
const fs = require('fs');
const path = require('path');

// Read and parse background.js to extract functions
const backgroundSource = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');

// Create a module that exports the functions
const moduleCode = `
${backgroundSource}

module.exports = {
  getSummary,
  getDraftResponse,
  getVideoSummary
};
`;

// Write temporary module
const tempModulePath = path.join(__dirname, 'temp-background.js');
fs.writeFileSync(tempModulePath, moduleCode);

// Export the functions
const backgroundFunctions = require('./temp-background.js');

// Clean up
fs.unlinkSync(tempModulePath);

module.exports = backgroundFunctions;
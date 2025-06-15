// This script helps you set up your API keys for local development
// Run: node setup-keys.js

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('Setting up API keys for the Chrome extension...\n');

const backgroundPath = path.join(__dirname, 'background.js');
let backgroundContent = fs.readFileSync(backgroundPath, 'utf8');

function updateKey(content, keyName, keyValue) {
  const regex = new RegExp(`const ${keyName} = '.*?';`);
  return content.replace(regex, `const ${keyName} = '${keyValue}';`);
}

rl.question('Enter your OpenAI API key: ', (openaiKey) => {
  rl.question('Enter your Anthropic API key: ', (anthropicKey) => {
    
    backgroundContent = updateKey(backgroundContent, 'OPENAI_API_KEY', openaiKey);
    backgroundContent = updateKey(backgroundContent, 'ANTHROPIC_API_KEY', anthropicKey);
    
    fs.writeFileSync(backgroundPath, backgroundContent);
    
    console.log('\n✅ API keys have been updated in background.js');
    console.log('⚠️  Remember: Do not commit background.js with real API keys!');
    
    rl.close();
  });
});
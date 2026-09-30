#!/usr/bin/env node
const { passwordHash } = require('../auth');

const password = process.argv[2];
if (!password) {
    console.error('Usage: npm run hash-password -- "a long password"');
    process.exit(1);
}
passwordHash(password).then(hash => console.log(hash)).catch(error => {
    console.error(error.message);
    process.exit(1);
});

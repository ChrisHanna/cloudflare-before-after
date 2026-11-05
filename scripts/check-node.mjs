const [major, minor] = process.versions.node.split('.').map(Number);
if (!((major === 22 && minor >= 12) || major >= 24)) {
  console.error('Use Node.js 22.12+ (22.x) or Node.js 24+.');
  process.exitCode = 1;
}

module.exports = {
    apps: [{
        name: 'wyntrax-mcp',
        script: 'src/index.http.js',
        cwd: '/var/www/wyntrax/product/mcp-server',
        env: { HTTP_PORT: 3011 },
        env_file: '/var/www/wyntrax/product/mcp-server/.env',
    }]
}

module.exports = {
    apps: [{
        name: 'wyntrax-mcp',
        script: 'src/index.http.js',
        cwd: '/var/www/wyntrax-mcp',
        env_file: '/var/www/wyntrax/.env',  // point to wyntrax's .env
    }]
}

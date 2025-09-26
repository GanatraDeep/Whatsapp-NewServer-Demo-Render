const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Store all WhatsApp clients
const clients = {};
const clientStatus = {};

// Create sessions directory if it doesn't exist
const sessionsDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
}

// Helper function to sanitize session names for clientId
const sanitizeSessionName = (sessionName) => {
    return sessionName
        .replace(/@/g, '_at_')
        .replace(/\./g, '_dot_')
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
};

// Helper function to get the actual session name used in clients object
const getActualSessionName = (requestedSessionName) => {
    if (clients[requestedSessionName]) {
        return requestedSessionName;
    }
    
    const sanitized = sanitizeSessionName(requestedSessionName);
    if (clients[sanitized]) {
        return sanitized;
    }
    
    const commonMappings = {
        'divtech6@gmail.com': 'divtech6_at_gmail_dot_com',
        'letssizzleit@gmail.com': 'letssizzleit_at_gmail_dot_com',
        'urbananimal@gmail.com': 'urbananimal_at_gmail_dot_com'
    };
    
    if (commonMappings[requestedSessionName] && clients[commonMappings[requestedSessionName]]) {
        return commonMappings[requestedSessionName];
    }
    
    return null;
};

// Get Puppeteer configuration based on environment
const getPuppeteerConfig = () => {
    const isProduction = process.env.NODE_ENV === 'production';
    const browserlessUrl = process.env.BROWSERLESS_URL;
    const browserlessToken = process.env.BROWSERLESS_TOKEN;
    
    // Option 1: Use Browserless.io service
    if (browserlessUrl && browserlessToken) {
        console.log('Using Browserless.io service');
        return {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ],
            // Connect to browserless WebSocket endpoint
            browserWSEndpoint: `${browserlessUrl}?token=${browserlessToken}`
        };
    }
    
    // Option 2: Use Puppeteer with minimal Chrome (for platforms like Railway)
    if (isProduction) {
        console.log('Using production Puppeteer config');
        return {
            headless: true,
            executablePath: process.env.GOOGLE_CHROME_BIN || '/usr/bin/google-chrome-stable',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-gpu',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-features=TranslateUI',
                '--disable-ipc-flooding-protection',
                '--memory-pressure-off'
            ]
        };
    }
    
    // Option 3: Development configuration
    console.log('Using development Puppeteer config');
    return {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    };
};

// Enhanced session creation with browser service support
const createSession = async (sessionName) => {
    if (clients[sessionName]) {
        console.log(`Session ${sessionName} already exists.`);
        return clients[sessionName];
    }

    try {
        console.log(`Creating WhatsApp session: ${sessionName}`);
        
        const sanitizedClientId = sanitizeSessionName(sessionName);
        console.log(`Using sanitized clientId: ${sanitizedClientId}`);
        
        const puppeteerConfig = getPuppeteerConfig();
        
        const client = new Client({
            authStrategy: new LocalAuth({
                clientId: sanitizedClientId,
                dataPath: path.join(sessionsDir, sanitizedClientId)
            }),
            puppeteer: puppeteerConfig,
            // Add retry and timeout configurations
            qrMaxRetries: 5,
            authTimeoutMs: 60000,
            restartOnAuthFail: true
        });

        // QR Code event
        client.on('qr', (qr) => {
            console.log(`QR Code for session ${sessionName}:`);
            qrcode.generate(qr, { small: true });
            clientStatus[sessionName] = 'qr_generated';
        });

        // Ready event
        client.on('ready', () => {
            console.log(`WhatsApp session ${sessionName} is ready!`);
            clientStatus[sessionName] = 'ready';
        });

        // Authentication success
        client.on('authenticated', () => {
            console.log(`Session ${sessionName} authenticated successfully!`);
            clientStatus[sessionName] = 'authenticated';
        });

        // Authentication failure
        client.on('auth_failure', (msg) => {
            console.error(`Authentication failed for session ${sessionName}:`, msg);
            clientStatus[sessionName] = 'auth_failed';
        });

        // Disconnected event
        client.on('disconnected', (reason) => {
            console.log(`Session ${sessionName} disconnected:`, reason);
            clientStatus[sessionName] = 'disconnected';
            if (clients[sessionName]) {
                delete clients[sessionName];
            }
        });

        // Message event
        client.on('message', async (message) => {
            console.log(`[${sessionName}] Received message from ${message.from}: ${message.body}`);
        });

        // Initialize the client with timeout
        const initTimeout = setTimeout(() => {
            console.error(`Session ${sessionName} initialization timeout`);
            clientStatus[sessionName] = 'timeout';
        }, 60000);

        await client.initialize();
        clearTimeout(initTimeout);
        
        clients[sessionName] = client;
        clientStatus[sessionName] = 'initializing';

        return client;
    } catch (error) {
        console.error(`Failed to create session ${sessionName}:`, error);
        clientStatus[sessionName] = 'error';
        throw error;
    }
};

// Helper function to format phone number
const formatPhoneNumber = (number) => {
    const numberStr = String(number);
    const cleaned = numberStr.replace(/\D/g, '');
    
    if (!cleaned || cleaned.length < 10) {
        throw new Error('Invalid phone number format');
    }
    
    if (!cleaned.startsWith('91') && cleaned.length === 10) {
        return `91${cleaned}@c.us`;
    } else if (cleaned.startsWith('91') && cleaned.length === 12) {
        return `${cleaned}@c.us`;
    } else if (cleaned.length === 10) {
        return `91${cleaned}@c.us`;
    } else {
        return `${cleaned}@c.us`;
    }
};

// Helper function to download media from URL
const downloadMedia = async (url) => {
    try {
        const response = await axios.get(url, { 
            responseType: 'arraybuffer',
            timeout: 30000,
            maxContentLength: 50 * 1024 * 1024 // 50MB limit
        });
        const buffer = Buffer.from(response.data);
        const contentType = response.headers['content-type'] || 'application/octet-stream';
        return MessageMedia.fromBuffer(buffer, contentType);
    } catch (error) {
        throw new Error(`Failed to download media: ${error.message}`);
    }
};

// Original send message endpoint (backward compatibility)
app.post('/send-message', async (req, res) => {
    const { sessionName, number, message } = req.body;

    if (!sessionName || !number || !message) {
        return res.status(400).json({ error: 'Missing sessionName, number, or message' });
    }

    try {
        const actualSessionName = getActualSessionName(sessionName);
        if (!actualSessionName) {
            return res.status(400).json({ 
                error: `Session ${sessionName} not found. Available sessions: ${Object.keys(clients).join(', ')}` 
            });
        }
        
        let client = clients[actualSessionName];
        
        if (!client || clientStatus[actualSessionName] !== 'ready') {
            return res.status(400).json({ 
                error: `Session ${sessionName} is not ready. Status: ${clientStatus[actualSessionName] || 'not_found'}` 
            });
        }

        const formattedNumber = formatPhoneNumber(number);
        
        const isRegistered = await client.isRegisteredUser(formattedNumber);
        if (!isRegistered) {
            return res.status(400).json({ error: 'Phone number is not registered on WhatsApp' });
        }

        await client.sendMessage(formattedNumber, message);
        res.status(200).json({ success: true, number: formattedNumber });
    } catch (error) {
        console.error(`Error sending message:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Enhanced unified message endpoint
app.post('/send-unified-message', async (req, res) => {
    const {
        sessionName,
        number,
        type,
        message,
        fileUrl,
        caption,
        link,
        title,
        options
    } = req.body;

    if (!sessionName || !number || !type) {
        return res.status(400).json({ error: 'Missing required fields: sessionName, number, or type' });
    }

    try {
        const actualSessionName = getActualSessionName(sessionName);
        if (!actualSessionName) {
            return res.status(400).json({ 
                error: `Session ${sessionName} not found. Available sessions: ${Object.keys(clients).join(', ')}` 
            });
        }
        
        let client = clients[actualSessionName];
        
        if (!client || clientStatus[actualSessionName] !== 'ready') {
            return res.status(400).json({ 
                error: `Session ${sessionName} is not ready. Status: ${clientStatus[actualSessionName] || 'not_found'}` 
            });
        }

        const formattedNumber = formatPhoneNumber(number);
        
        const isRegistered = await client.isRegisteredUser(formattedNumber);
        if (!isRegistered) {
            return res.status(400).json({ error: 'Phone number is not registered on WhatsApp' });
        }

        switch (type.toLowerCase()) {
            case 'text':
                if (!message) throw new Error('Missing "message" for text type');
                await client.sendMessage(formattedNumber, message);
                break;

            case 'image':
                if (!fileUrl) throw new Error('Missing "fileUrl" for image type');
                const imageMedia = await downloadMedia(fileUrl);
                await client.sendMessage(formattedNumber, imageMedia, { caption: caption || '' });
                break;

            case 'file':
            case 'document':
                if (!fileUrl) throw new Error('Missing "fileUrl" for file type');
                const fileMedia = await downloadMedia(fileUrl);
                await client.sendMessage(formattedNumber, fileMedia, { caption: caption || '' });
                break;

            case 'audio':
                if (!fileUrl) throw new Error('Missing "fileUrl" for audio type');
                const audioMedia = await downloadMedia(fileUrl);
                await client.sendMessage(formattedNumber, audioMedia, { sendAudioAsVoice: true });
                break;

            case 'video':
                if (!fileUrl) throw new Error('Missing "fileUrl" for video type');
                const videoMedia = await downloadMedia(fileUrl);
                await client.sendMessage(formattedNumber, videoMedia, { caption: caption || '' });
                break;

            case 'link':
                if (!link || !message) throw new Error('Missing "link" or "message" for link preview');
                await client.sendMessage(formattedNumber, message, { linkPreview: true });
                break;

            default:
                throw new Error(`Unsupported message type: ${type}`);
        }

        res.status(200).json({ success: true, number: formattedNumber });
    } catch (error) {
        console.error(`Error sending unified message:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Health check endpoint with browser status
app.get('/health', (req, res) => {
    const sessionStatuses = {};
    for (const sessionName of Object.keys(clients)) {
        sessionStatuses[sessionName] = clientStatus[sessionName] || 'unknown';
    }
    
    res.json({
        status: 'running',
        environment: process.env.NODE_ENV || 'development',
        browserService: process.env.BROWSERLESS_URL ? 'browserless' : 'local',
        sessions: sessionStatuses,
        timestamp: new Date().toISOString()
    });
});

// Session management endpoints
app.post('/create-session', async (req, res) => {
    const { sessionName } = req.body;
    
    if (!sessionName) {
        return res.status(400).json({ error: 'Missing sessionName' });
    }
    
    const existingSession = getActualSessionName(sessionName);
    if (existingSession) {
        return res.status(400).json({ 
            error: 'Session already exists',
            existingSessionName: existingSession
        });
    }
    
    try {
        await createSession(sessionName);
        const actualSessionName = sanitizeSessionName(sessionName);
        res.json({ 
            success: true, 
            message: `Session ${sessionName} created.`,
            sessionName: sessionName,
            actualSessionName: actualSessionName,
            status: clientStatus[actualSessionName]
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/session/:sessionName', async (req, res) => {
    const { sessionName } = req.params;
    
    try {
        const actualSessionName = getActualSessionName(sessionName);
        if (actualSessionName && clients[actualSessionName]) {
            await clients[actualSessionName].destroy();
            delete clients[actualSessionName];
            delete clientStatus[actualSessionName];
            
            const sanitizedClientId = sanitizeSessionName(sessionName);
            const sessionPath = path.join(sessionsDir, sanitizedClientId);
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
            }
            
            res.json({ 
                success: true, 
                message: `Session ${sessionName} deleted`,
                deletedSessionName: actualSessionName
            });
        } else {
            res.status(404).json({ 
                error: 'Session not found',
                available: Object.keys(clients)
            });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get session status
app.get('/session/:sessionName/status', (req, res) => {
    const { sessionName } = req.params;
    const actualSessionName = getActualSessionName(sessionName);
    
    if (!actualSessionName) {
        return res.status(404).json({ 
            error: 'Session not found',
            available: Object.keys(clients)
        });
    }
    
    const status = clientStatus[actualSessionName];
    
    res.json({
        requestedSessionName: sessionName,
        actualSessionName: actualSessionName,
        status: status || 'unknown',
        exists: !!clients[actualSessionName]
    });
});

// Get QR code endpoint
app.get('/qr/:sessionName', async (req, res) => {
    const { sessionName } = req.params;
    const actualSessionName = getActualSessionName(sessionName);
    
    if (!actualSessionName || !clients[actualSessionName]) {
        return res.status(404).json({ 
            error: 'Session not found',
            available: Object.keys(clients)
        });
    }
    
    const status = clientStatus[actualSessionName];
    res.json({ 
        sessionName, 
        actualSessionName,
        status,
        message: status === 'qr_generated' ? 'Check console for QR code' : `Session status: ${status}`
    });
});

const PORT = process.env.PORT || 3000;

const startServer = async () => {
    try {
        console.log('Starting WhatsApp API server...');
        console.log('Environment:', process.env.NODE_ENV || 'development');
        console.log('Browser service:', process.env.BROWSERLESS_URL ? 'Browserless.io' : 'Local Puppeteer');
        
        // Start Express server
        const server = app.listen(PORT, () => {
            console.log(`Multi-Session WhatsApp API server listening on port ${PORT}`);
            console.log(`Available endpoints:`);
            console.log(`- POST /send-message (legacy)`);
            console.log(`- POST /send-unified-message`);
            console.log(`- POST /create-session`);
            console.log(`- DELETE /session/:sessionName`);
            console.log(`- GET /session/:sessionName/status`);
            console.log(`- GET /health`);
        });
        
        // Graceful shutdown
        process.on('SIGINT', async () => {
            console.log('Shutting down server gracefully...');
            
            for (const [sessionName, client] of Object.entries(clients)) {
                try {
                    console.log(`Closing session: ${sessionName}`);
                    await client.destroy();
                } catch (error) {
                    console.error(`Error closing session ${sessionName}:`, error);
                }
            }
            
            server.close();
            process.exit(0);
        });
        
    } catch (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
};

// Start the server
startServer();
const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { spawn } = require('child_process');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

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
    // Replace @ and . with underscores, remove other special characters
    return sessionName
        .replace(/@/g, '_at_')
        .replace(/\./g, '_dot_')
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .replace(/_+/g, '_') // Replace multiple underscores with single
        .replace(/^_|_$/g, ''); // Remove leading/trailing underscores
};

// Helper function to get the actual session name used in clients object
const getActualSessionName = (requestedSessionName) => {
    // First check if the exact session name exists
    if (clients[requestedSessionName]) {
        return requestedSessionName;
    }
    
    // If not found, try the sanitized version
    const sanitized = sanitizeSessionName(requestedSessionName);
    if (clients[sanitized]) {
        return sanitized;
    }
    
    // Check for common mappings
    const commonMappings = {
        'divtech6@gmail.com': 'divtech6_at_gmail_dot_com',
        'letssizzleit@gmail.com': 'letssizzleit_at_gmail_dot_com',
        'urbananimal@gmail.com': 'urbananimal_at_gmail_dot_com'
    };
    
    if (commonMappings[requestedSessionName] && clients[commonMappings[requestedSessionName]]) {
        return commonMappings[requestedSessionName];
    }
    
    // Return null if no session found
    return null;
};

// Enhanced session creation with better error handling
const createSession = async (sessionName) => {
    if (clients[sessionName]) {
        console.log(`Session ${sessionName} already exists.`);
        return clients[sessionName];
    }

    try {
        console.log(`Creating WhatsApp session: ${sessionName}`);
        
        // Sanitize session name for clientId
        const sanitizedClientId = sanitizeSessionName(sessionName);
        console.log(`Using sanitized clientId: ${sanitizedClientId}`);
        
        const client = new Client({
            authStrategy: new LocalAuth({
                clientId: sanitizedClientId,
                dataPath: path.join(sessionsDir, sanitizedClientId)
            }),
            puppeteer: {
                headless: 'new',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu',
                    '--disable-web-security',
                    '--disable-features=VizDisplayCompositor',
                    '--disable-extensions',
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding',
                    '--disable-ipc-flooding-protection',
                    '--single-process', // Important for VPS
                    '--memory-pressure-off'
                ],
                executablePath: '/usr/bin/chromium-browser' // Use system Chrome
            }
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
            // Clean up the client
            if (clients[sessionName]) {
                delete clients[sessionName];
            }
        });

        // Message event (optional - for incoming messages)
        client.on('message', async (message) => {
            console.log(`[${sessionName}] Received message from ${message.from}: ${message.body}`);
        });

        // Initialize the client
        await client.initialize();
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
    // Convert to string first to handle numbers passed as integers
    const numberStr = String(number);
    
    // Remove any non-digit characters
    const cleaned = numberStr.replace(/\D/g, '');
    
    // Validate that we have a valid number
    if (!cleaned || cleaned.length < 10) {
        throw new Error('Invalid phone number format');
    }
    
    // If it doesn't start with country code, add India code (91)
    if (!cleaned.startsWith('91') && cleaned.length === 10) {
        return `91${cleaned}@c.us`;
    } else if (cleaned.startsWith('91') && cleaned.length === 12) {
        return `${cleaned}@c.us`;
    } else if (cleaned.length === 10) {
        return `91${cleaned}@c.us`;
    } else {
        // For other country codes or lengths, use as is
        return `${cleaned}@c.us`;
    }
};

// Helper function to download media from URL
const downloadMedia = async (url) => {
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer' });
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
        // Get the actual session name used internally
        const actualSessionName = getActualSessionName(sessionName);
        if (!actualSessionName) {
            return res.status(400).json({ 
                error: `Session ${sessionName} not found. Available sessions: ${Object.keys(clients).join(', ')}` 
            });
        }
        
        let client = clients[actualSessionName];
        
        // Check if client exists and is ready
        if (!client || clientStatus[actualSessionName] !== 'ready') {
            return res.status(400).json({ 
                error: `Session ${sessionName} is not ready. Status: ${clientStatus[actualSessionName] || 'not_found'}` 
            });
        }

        const formattedNumber = formatPhoneNumber(number);
        
        // Check if number exists on WhatsApp
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
        options // For polls
    } = req.body;

    if (!sessionName || !number || !type) {
        return res.status(400).json({ error: 'Missing required fields: sessionName, number, or type' });
    }

    try {
        // Get the actual session name used internally
        const actualSessionName = getActualSessionName(sessionName);
        if (!actualSessionName) {
            return res.status(400).json({ 
                error: `Session ${sessionName} not found. Available sessions: ${Object.keys(clients).join(', ')}` 
            });
        }
        
        let client = clients[actualSessionName];
        
        // Check if client exists and is ready
        if (!client || clientStatus[actualSessionName] !== 'ready') {
            return res.status(400).json({ 
                error: `Session ${sessionName} is not ready. Status: ${clientStatus[actualSessionName] || 'not_found'}` 
            });
        }

        const formattedNumber = formatPhoneNumber(number);
        
        // Check if number exists on WhatsApp
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
                const linkMessage = `${message}\n\n${link}`;
                await client.sendMessage(formattedNumber, message, { linkPreview: true });
                break;

            case 'location':
                const { latitude, longitude, name, address } = req.body;
                if (!latitude || !longitude) throw new Error('Missing latitude or longitude for location');
                await client.sendMessage(formattedNumber, new Location(latitude, longitude, name || '', address || ''));
                break;

            case 'contact':
                const { contactName, contactNumber } = req.body;
                if (!contactName || !contactNumber) throw new Error('Missing contactName or contactNumber');
                const contact = await MessageMedia.fromFilePath('./contact.vcf'); // You'd need to create this
                await client.sendMessage(formattedNumber, contact);
                break;

            case 'poll':
                if (!message || !options || !Array.isArray(options)) {
                    throw new Error('Missing "message" or "options" array for poll type');
                }
                try {
                    await client.sendMessage(formattedNumber, new Poll(message, options));
                } catch (pollError) {
                    console.log('Poll creation failed, sending as text:', pollError.message);
                    const pollText = `${message}\n\n${options.map((opt, idx) => `${idx + 1}. ${opt}`).join('\n')}`;
                    await client.sendMessage(formattedNumber, pollText);
                }
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

// Get session QR code endpoint
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

// Health check endpoint
app.get('/health', (req, res) => {
    const sessionStatuses = {};
    for (const sessionName of Object.keys(clients)) {
        sessionStatuses[sessionName] = clientStatus[sessionName] || 'unknown';
    }
    
    res.json({
        status: 'running',
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
    
    // Check if session already exists (either original or sanitized name)
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
            
            // Clean up session files
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

// Logout session
app.post('/session/:sessionName/logout', async (req, res) => {
    const { sessionName } = req.params;
    
    try {
        const actualSessionName = getActualSessionName(sessionName);
        if (actualSessionName && clients[actualSessionName]) {
            await clients[actualSessionName].logout();
            res.json({ 
                success: true, 
                message: `Session ${sessionName} logged out`,
                actualSessionName: actualSessionName
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

const PORT = process.env.PORT || 3000;
const NGROK_AUTH_TOKEN = '2vROpWnCYrzxgCFCI0s3AuC5jhB_59HEFp3z2ahdMWhohUabn';
const NGROK_DOMAIN = 'related-locally-lamprey.ngrok-free.app';

// Function to start ngrok as a child process
const startNgrok = (port) => {
    console.log('Starting ngrok tunnel...');

    const ngrokArgs = [
        'http', 
        port.toString(), 
        '--authtoken', 
        process.env.NGROK_AUTH_TOKEN || NGROK_AUTH_TOKEN
    ];
    
    if (process.env.NGROK_DOMAIN || NGROK_DOMAIN) {
        ngrokArgs.push('--domain', process.env.NGROK_DOMAIN || NGROK_DOMAIN);
    }
    
    const ngrokProcess = spawn('ngrok', ngrokArgs);
    
    ngrokProcess.stdout.on('data', (data) => {
        console.log(`ngrok stdout: ${data}`);
    });
    
    ngrokProcess.stderr.on('data', (data) => {
        console.error(`ngrok stderr: ${data}`);
    });
    
    ngrokProcess.on('close', (code) => {
        if (code !== 0) {
            console.error(`ngrok process exited with code ${code}`);
            console.log('Attempting to start ngrok without domain...');
            
            const fallbackProcess = spawn('ngrok', [
                'http', 
                port.toString(), 
                '--authtoken', 
                NGROK_AUTH_TOKEN
            ]);
            
            fallbackProcess.stdout.on('data', (data) => {
                console.log(`ngrok fallback stdout: ${data}`);
            });
        }
    });
    
    ngrokProcess.on('error', (err) => {
        console.error('Failed to start ngrok process:', err);
    });
    
    return ngrokProcess;
};

const startServer = async () => {
    try {
        console.log('Starting WhatsApp API server with whatsapp-web.js...');
        
        // Create WhatsApp sessions
        console.log('Creating WhatsApp sessions...');
        // await createSession("divtech6_at_gmail_dot_com");
        // await new Promise(resolve => setTimeout(resolve, 3000));
        
        // await createSession("letssizzleit_at_gmail_dot_com");
        // await new Promise(resolve => setTimeout(resolve, 3000));
        
        // await createSession("urbananimal-session");
        // await new Promise(resolve => setTimeout(resolve, 3000));
        
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
            
            // Start ngrok
            try {
                startNgrok(PORT);
            } catch (error) {
                console.error('Error setting up ngrok:', error);
            }
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
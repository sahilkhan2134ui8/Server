const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const Pino = require("pino");
const fs = require("fs");
const readline = require("readline");
const process = require("process");
const dns = require("dns");

// Interfață simplă pentru input
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Delay simplu
const delay = (ms) => new Promise(res => setTimeout(res, ms));

// Fișiere pentru progres și autentificare
const PROGRESS_FILE = "progress.json";
const AUTH_FOLDER = "./auth_info";

// Salvare progres (indexul ultimului mesaj trimis)
function saveProgress(index) {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ lastIndex: index }), "utf-8");
}

// Încărcare progres
function loadProgress() {
    if (fs.existsSync(PROGRESS_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf-8"));
            return data.lastIndex || 0;
        } catch (e) {
            return 0;
        }
    }
    return 0;
}

// Funcție simplă pentru a întreba input
function askQuestion(query) {
    return new Promise((resolve) => {
        rl.question(query, (answer) => {
            resolve(answer.trim());
        });
    });
}

// Funcție de keep-alive: trimite periodic update de prezență
function startKeepAlive(socket) {
    setInterval(() => {
        try {
            socket.sendPresenceUpdate("available");
            // Nu afișăm loguri pentru keep-alive
        } catch (e) {
            // Ignorăm erorile de keep-alive
        }
    }, 60000); // la fiecare 60 de secunde
}

// Verifică conexiunea la internet și așteaptă până revine
async function waitForInternet() {
    console.log("🔄 Waiting for internet to come back...");
    return new Promise((resolve) => {
        const interval = setInterval(() => {
            dns.resolve("google.com", (err) => {
                if (!err) {
                    console.log("✅ Internet is back! Reconnecting...");
                    clearInterval(interval);
                    resolve(true);
                }
            });
        }, 5000);
    });
}

// Inițializează conexiunea la WhatsApp și menține stabilitatea
async function startBot() {
    console.log("🔥 Starting WhatsApp Bot...");

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    let socket = makeWASocket({
        auth: state,
        logger: Pino({ level: "silent" }),
        connectTimeoutMs: 60000,
        browser: ["WhatsApp Bot", "Chrome", "1.0"]
    });

    // Dacă nu este înregistrată sesiunea, cere pairing code
    if (!socket.authState.creds.registered) {
        const phoneNumber = await askQuestion("Enter your phone number for pairing (e.g. 40748427351): ");
        try {
            const pairingCode = await socket.requestPairingCode(phoneNumber);
            console.log(`✅ Pairing code: ${pairingCode}`);
            console.log("Please open WhatsApp and enter this code under 'Linked Devices'.");
        } catch (error) {
            console.error("❌ Error generating pairing code:", error);
        }
    } else {
        console.log("✅ Session is already authenticated!");
    }

    // Evenimente de conexiune
    socket.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "open") {
            console.log("✅ Connected to WhatsApp!");
            startKeepAlive(socket); // Începem heartbeat-ul pentru a menține conexiunea
            await afterConnection(socket);
        } else if (connection === "close") {
            console.log("⚠️ Connection closed.");
            const reason = lastDisconnect?.error?.output?.statusCode;

            if (reason !== DisconnectReason.loggedOut) {
                await waitForInternet();
                await startBot();
            } else {
                console.log("❌ Logged out. Restart the script to reauthenticate.");
                process.exit(1);
            }
        }
    });

    socket.ev.on("creds.update", saveCreds);
    return socket;
}

// După conectare, solicită datele despre unde se trimit mesajele și începe trimiterea
async function afterConnection(sock) {
    let targets, messages, msgDelay;
    
    if (globalThis.targets && globalThis.messages && globalThis.msgDelay) {
        console.log("📩 Resuming message sending from where it left off...");
        targets = globalThis.targets;
        messages = globalThis.messages;
        msgDelay = globalThis.msgDelay;
    } else {
        console.log("\n🌐 Where would you like to send messages?");
        console.log("[1] Contacts");
        console.log("[2] Groups");

        const choice = await askQuestion("Enter your choice (1 or 2): ");
        targets = [];

        if (choice === "1") {
            const numContacts = parseInt(await askQuestion("How many contacts? "), 10);
            for (let i = 0; i < numContacts; i++) {
                const targetNumber = await askQuestion(`Enter phone number for Contact ${i + 1} (without +, e.g. 40748427351): `);
                targets.push(`${targetNumber}@s.whatsapp.net`);
            }
        } else if (choice === "2") {
            console.log("Fetching group information...");
            try {
                const groupMetadata = await sock.groupFetchAllParticipating();
                const groups = Object.values(groupMetadata);
                console.log("\nAvailable groups:");
                groups.forEach((g) => {
                    console.log(`${g.subject} - ID: ${g.id}`);
                });
                const numGroups = parseInt(await askQuestion("How many groups? "), 10);
                for (let i = 0; i < numGroups; i++) {
                    const groupJID = await askQuestion(`Enter group ID for Group ${i + 1} (e.g. 1234567890-123456@g.us): `);
                    targets.push(groupJID);
                }
            } catch (error) {
                console.error("❌ Error fetching groups:", error);
                process.exit(1);
            }
        } else {
            console.log("❌ Invalid choice. Exiting.");
            process.exit(1);
        }

        const filePath = await askQuestion("Enter the path to your text file (e.g., spam.txt): ");
        if (!fs.existsSync(filePath)) {
            console.error("❌ File not found. Please check the path and try again.");
            process.exit(1);
        }
        messages = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
        msgDelay = parseInt(await askQuestion("Enter the delay in seconds between messages: "), 10) * 1000;

        globalThis.targets = targets;
        globalThis.messages = messages;
        globalThis.msgDelay = msgDelay;
    }

    resumeSending(sock, targets, messages, msgDelay);
}

// Funcția care reia trimiterea mesajelor de unde a rămas
async function resumeSending(sock, targets, messages, msgDelay) {
    let currentIndex = loadProgress();

    while (true) {
        for (let i = currentIndex; i < messages.length; i++) {
            for (const target of targets) {
                try {
                    await sock.sendMessage(target, { text: messages[i] });
                    console.log(`📤 Sent to ${target}: "${messages[i]}"`);
                    saveProgress(i);
                } catch (error) {
                    // Filtrăm erorile 408 și 428 pentru a nu le afișa
                    if (![408, 428].includes(error?.output?.statusCode)) {
                        console.error(`❌ Error sending message to ${target}:`, error);
                    }
                }
                await delay(msgDelay);
            }
            currentIndex = i + 1;
        }
        currentIndex = 0;
    }
}

// Handlers pentru a nu opri scriptul la erori
process.on("uncaughtException", (err) => {});
process.on("unhandledRejection", (reason) => {});

// Pornește botul
startBot();

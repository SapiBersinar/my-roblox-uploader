// netlify/functions/upload.js

// Import library yang dibutuhkan
const fetch = require('node-fetch');
const FormData = require('form-data');
const formidable = require('formidable');
const { Readable } = require('stream'); // Import Readable stream
const fs = require('fs');
const path = require('path');

// Fungsi untuk melakukan polling (memeriksa status operasi)
const pollOperation = async (apiKey, operationId) => {
    const url = `https://apis.roblox.com/assets/v1/operations/${operationId}`;
    const start = Date.now();
    // Timeout 2 menit (120000 ms)
    while (Date.now() - start < 120000) {
        try {
            const res = await fetch(url, { headers: { 'x-api-key': apiKey } });
            const data = await res.json();
            if (res.status === 200 && data.done) {
                return data;
            }
        } catch (error) {
            console.error(`Error saat polling: ${error.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
    return null; // Mengembalikan null jika timeout
};

// Handler utama untuk Netlify Function
exports.handler = async (event) => {
    try {
        if (event.httpMethod !== 'POST') {
            return {
                statusCode: 405,
                body: JSON.stringify({ status: 'error', message: 'Metode tidak diizinkan.' })
            };
        }
        
        // Logika untuk Netlify Function yang menerima body Base64
        const form = new formidable.Formidable({
            keepExtensions: true,
            maxFileSize: 5 * 1024 * 1024, // Batas ukuran file 5MB
            multiples: false // Hanya memproses satu file per request
        });

        // Membuat Readable stream dari event.body (yang sudah di-Base64-encode)
        // Ini adalah perbaikan utama untuk mengatasi "req.on is not a function"
        const reqStream = new Readable();
        reqStream.push(Buffer.from(event.body, 'base64'));
        reqStream.push(null); // Menandakan akhir stream

        // Membuat objek "request" tiruan yang dibutuhkan oleh formidable
        const mockRequest = {
            headers: event.headers,
            ...reqStream
        };

        // Menggunakan formidable untuk mem-parsing body dari stream
        const [fields, files] = await form.parse(mockRequest);

        // Formidable versi 3.x mengembalikan array, jadi kita ambil elemen pertama
        const apiKey = fields.apiKey?.[0];
        const userId = fields.userId?.[0];
        const displayName = fields.displayName?.[0];
        const description = fields.description?.[0];
        const file = files.fileContent?.[0];

        if (!apiKey || !userId || !file) {
            return {
                statusCode: 400,
                body: JSON.stringify({ status: 'error', message: 'Data tidak lengkap.' })
            };
        }
        
        // Buat FormData untuk dikirim ke API Roblox
        const formData = new FormData();
        const requestPayload = {
            assetType: "TShirt",
            displayName,
            description,
            creationContext: { creator: { userId } }
        };

        formData.append("request", JSON.stringify(requestPayload), {
            contentType: 'application/json'
        });
        formData.append("fileContent", fs.createReadStream(file.filepath), {
            filename: file.originalFilename,
            contentType: file.mimetype
        });

        // Buat permintaan unggahan awal ke API Roblox
        const uploadRes = await fetch("https://apis.roblox.com/assets/v1/assets", {
            method: "POST",
            headers: {
                "x-api-key": apiKey,
                ...formData.getHeaders()
            },
            body: formData
        });

        const uploadData = await uploadRes.json();
        fs.unlinkSync(file.filepath); // Pastikan file sementara dihapus

        if (uploadRes.status !== 200 || !uploadData.operationId) {
            return {
                statusCode: uploadRes.status,
                body: JSON.stringify({ 
                    status: 'error', 
                    message: 'Gagal memulai unggahan ke Roblox.', 
                    robloxResponse: uploadData 
                })
            };
        }
        
        // Lakukan polling untuk menunggu unggahan selesai
        const pollResult = await pollOperation(apiKey, uploadData.operationId);

        if (pollResult && pollResult.response && pollResult.response.assetId) {
            return {
                statusCode: 200,
                body: JSON.stringify({
                    status: 'success',
                    message: 'Unggahan berhasil!',
                    assetId: pollResult.response.assetId,
                    name: displayName
                })
            };
        } else {
            return {
                statusCode: 500,
                body: JSON.stringify({
                    status: 'error',
                    message: 'Gagal menyelesaikan unggahan (timeout atau error polling).',
                    robloxPollingResponse: pollResult
                })
            };
        }

    } catch (error) {
        console.error(`Error saat mengunggah: ${error.message}`);
        return {
            statusCode: 500,
            body: JSON.stringify({ status: 'error', message: error.message })
        };
    }
};


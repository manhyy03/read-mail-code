const express = require('express');
const axios = require('axios');
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const qs = require('querystring');

const app = express();
const PORT = process.env.PORT || 3000;

// Hàm lấy token xác thực từ mail.tm
async function getAuthToken(email, password) {
    try {
        const response = await axios.post('https://api.mail.tm/token', { address: email, password }, {
            headers: { 'Content-Type': 'application/json' }
        });
        return response.data.token;
    } catch (error) {
        console.error('Lỗi khi lấy token:', error.response?.data || error.message);
        return null;
    }
}

// Hàm lấy danh sách email từ hộp thư
async function getEmails(token) {
    try {
        const response = await axios.get('https://api.mail.tm/messages', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        return response.data['hydra:member'];
    } catch (error) {
        console.error('Lỗi khi lấy danh sách email:', error.response?.data || error.message);
        return [];
    }
}

// 🟢 Hàm lấy nội dung email chi tiết
async function getEmailContent(token, emailId) {
    try {
        const response = await axios.get(`https://api.mail.tm/messages/${emailId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        return response.data.text || response.data.html || '';
    } catch (error) {
        console.error('Lỗi khi lấy nội dung email:', error.response?.data || error.message);
        return '';
    }
}

// 🟢 Hàm trích xuất mã xác thực từ nội dung email (loại bỏ mã màu hex)
function extractVerificationCode(emailContent) {
    const pattern = /\b\d{6}\b/g; // Tìm tất cả mã số 6 chữ số
    const matches = emailContent.match(pattern);

    if (!matches) return null;

    // Lọc những mã KHÔNG có dấu # ngay trước (để tránh mã màu hex)
    const filtered = matches.filter(code => {
        const index = emailContent.indexOf(code);
        return index === 0 || emailContent[index - 1] !== '#';
    });

    return filtered.length > 0 ? filtered[0] : null;
}


// 🟢 API lấy mã xác thực từ mail.tm
app.get('/get-code', async (req, res) => {
    const email = req.query.email;
    const password = req.query.password;

    if (!email || !password) {
        return res.status(400).json({ error: "Thiếu email hoặc mật khẩu" });
    }

    console.log(`Nhận yêu cầu từ: ${email}`);

    try {
        // 1️Lấy token
        const token = await getAuthToken(email, password);
        if (!token) return res.json({ code: "111111" });

        // 2️Kiểm tra hộp thư để lấy mã (Thử lại tối đa 3 lần)
        const allowedSenders = ["verify@x.com", "info@x.com", "account-security-noreply@accountprotection.microsoft.com", "noreply@account.tiktok.com"]; // Danh sách người gửi hợp lệ
        for (let i = 0; i < 3; i++) {
            const emails = await getEmails(token);
            const filteredEmails = emails.filter(email => allowedSenders.includes(email.from.address));

            if (filteredEmails.length > 0) {
                const latestEmail = filteredEmails[0]; // Email mới nhất từ người gửi hợp lệ
                const emailContent = await getEmailContent(token, latestEmail.id);
                const code = extractVerificationCode(emailContent);

                if (code) {
                    return res.json({ code });
                }
            }

            // Chờ 5 giây trước khi thử lại
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

        return res.json({ code: "111111" });
    } catch (error) {
        console.error('Lỗi:', error);
        return res.json({ code: "111111" });
    }
});

// ✅ Hàm tạo chuỗi ngẫu nhiên mạnh
function randomString(length) {
    const chars = 'abcde32fghijklmno34pq5rfahot0wtq489perqtyqpqhj4vlam8xnbnzbvbhdyqrstuvwxyz0123456789';
    return Array.from({ length }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
}

// ✅ Hàm tạo email với Mail.tm (retry tối đa 5 lần, delay 3s mỗi lần)
async function createMailTM(retries = 5) {
    for (let i = 0; i < retries; i++) {
        try {
            // Bước 1: Lấy danh sách domain từ Mail.tm
            const domainResponse = await axios.get('https://api.mail.tm/domains', { timeout: 3000 });
            const domains = domainResponse.data['hydra:member'];
            if (!domains.length) throw new Error("Không có domain nào khả dụng");

            // Bước 2: Tạo email ngẫu nhiên
            const email = `${randomString(10)}@${domains[Math.floor(Math.random() * domains.length)].domain}`;
            const password = randomString(8);

            // Bước 3: Tạo tài khoản trên Mail.tm
            const response = await axios.post('https://api.mail.tm/accounts', {
                address: email,
                password: password
            }, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 5000
            });

            return { email, password, accountInfo: response.data };
        } catch (error) {
            console.error(`Lỗi khi tạo email (thử lần ${i + 1}):`, error.message);
            if (i < retries - 1) await new Promise(res => setTimeout(res, 3000)); // Đợi 3 giây rồi thử lại
        }
    }
    throw new Error("Tạo email thất bại sau nhiều lần thử");
}

// ✅ API tạo email
app.get('/create-email', async (req, res) => {
    try {
        const emailData = await createMailTM();
        res.json(emailData);
    } catch (error) {
        console.error("Lỗi tạo email:", error.message);
        res.status(500).json({
            email: "error",
            password: "error",
            accountInfo: "error"
        });
    }
});

// 🔹 Hàm lấy mã từ mail.privateemail.com (IMAP)
async function getCodeFromIMAP(emailUser, emailPass, targetEmail) {
    return new Promise((resolve, reject) => {
        if (!emailUser || !emailPass || !targetEmail || !targetEmail.includes('@')) {
            return resolve({ code: 111111 }); // Trả về mã mặc định nếu thông tin không hợp lệ
        }

        const imap = new Imap({
            user: emailUser,
            password: emailPass,
            host: 'mail.privateemail.com',
            port: 993,
            tls: true
        });

        imap.once('ready', () => {
            imap.openBox('INBOX', false, (err, box) => {
                if (err) {
                    imap.end();
                    return reject(err);
                }

                // ✅ Sửa cú pháp `search`
                imap.search([['TO', targetEmail]], (err, results) => {
                    if (err || !results || results.length === 0) {
                        imap.end();
                        return resolve({ code: 111111 });
                    }

                    const latestEmailId = results[results.length - 1];

                    const fetchStream = imap.fetch(latestEmailId, { bodies: '' });

                    fetchStream.on('message', (msg) => {
                        let emailData = '';

                        msg.on('body', (stream) => {
                            stream.on('data', (chunk) => emailData += chunk.toString());

                            stream.once('end', async () => {
                                try {
                                    const parsed = await simpleParser(emailData);
                                    const body = parsed.text || '';
                                    const code = extractVerificationCode(body);
                                    resolve({ code: code || 111111 });
                                } catch (error) {
                                    resolve({ code: 111111 });
                                }
                            });
                        });
                    });

                    fetchStream.on('end', () => imap.end());
                });
            });
        });

        imap.once('error', (err) => {
            console.error('Lỗi IMAP:', err);
            resolve({ code: 111111 });
        });

        imap.connect();
    });
}

// 🔹 API lấy mã từ mail.privateemail.com (IMAP)
app.get('/get-private-code', async (req, res) => {
    const emailUser = req.query.emailUser;
    const emailPass = req.query.emailPass;
    const targetEmail = req.query.targetEmail;

    console.log(`Nhận request: user=${emailUser}, pass=${emailPass}, target=${targetEmail}`);

    if (!emailUser || !emailPass || !targetEmail) {
        return res.status(400).json({ error: "Thiếu thông tin đăng nhập" });
    }

    try {
        let code = null;
        for (let i = 0; i < 3; i++) {
            const result = await getCodeFromIMAP(emailUser, emailPass, targetEmail);
            if (result.code !== 111111) {
                code = result.code;
                break;
            }
            console.log(`Lần thử ${i + 1}: Không tìm thấy mã, chờ 5 giây...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

        res.json({ code: code || 111111 });
    } catch (error) {
        console.error('Lỗi:', error);
        res.json({ code: 111111 });
    }
});

// Code tempmail
// const API_KEY = "96|ZBPycVthyP6voOVTPY6EIoVA7nyexnOsdQiB957tcd4daf93";

app.get('/create-tempmail', async (req, res) => {
    const { key } = req.query;
    try {
        const domains = ["tempmail.id.vn", "1trick.net", "nghienplus.io.vn", "tempmail.ckvn.edu.vn"];
        const email = `${randomString(10)}`;
        const domain = domains[Math.floor(Math.random() * domains.length)];

        console.log(`Tạo email: ${email}@${domain}`);

        const response = await axios.post('https://tempmail.id.vn/api/email/create', {
            user: email,
            domain: domain
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${key}`
            },
        });

        // ✅ Gửi phản hồi về client
        res.json({
            id: response.data.data.id,
            email: response.data.data.email
        });
    } catch (error) {
        console.error("❌ Lỗi tạo email:", error.response?.data.data || error.message);
        res.status(500).json({
            email: "error",
            id: "error",
        });
    }
});

app.get('/get-code-tempmail', async (req, res) => {
    const { id, key } = req.query;
    console.log(`Nhận yêu cầu get code form id mail: ${id}`);
    try {
        const lisMail = await axios.get(`https://tempmail.id.vn/api/email/${id}`, {
            headers: { 'Authorization': `Bearer ${key}` },
        })
        const idMail = lisMail.data.data.items[0].id;
        const getCode = await axios.get(`https://tempmail.id.vn/api/message/${idMail}`, {
            headers: { 'Authorization': `Bearer ${key}` },
        })
        try {
            const code = extractVerificationCode(getCode.data.data.body);
            if (code) {
                // console.log("code", code);
                return res.json({ code: code })
            }
        } catch (error) {
            console.error('Lỗi:', error);
            return res.json({ code: "111111" });
        }
    } catch (error) {
        console.error('Lỗi:', error);
        return res.json({ code: "111111" });
    }
});

// code mail gemmmo
app.get('/get-code-gemmmo', async (req, res) => {
    const { email, password } = req.query;
    console.log(`Nhận yêu cầu get code từ email: ${email}`);

    if (!email || !password) {
        return res.json({ error: "Thiếu email hoặc mật khẩu" });
    }

    try {
        const response = await axios.post(
            'https://gemmmo.vn/api/email/getEmailContentByEmail',
            {
                email: email,
                password: password,
            },
            {
                headers: { 'Content-Type': 'application/json' }
            }
        );

        const emailText = response.data?.data?.[0]?.text || "";
        const code = extractVerificationCode(emailText);

        if (code) {
            return res.json({ code: code });
        }

        return res.json({ code: "111111" });
    } catch (error) {
        console.error("Lỗi khi gọi API hoặc xử lý dữ liệu - gemmo");
        return res.json({ code: "111111" });
    }
});

//hotmail code
async function getTokenFromCode(id, code) {
    const data = {
        client_id: id,
        scope: 'https://graph.microsoft.com/User.Read offline_access',
        code: code,
        redirect_uri: 'https://login.microsoftonline.com/common/oauth2/nativeclient',
        grant_type: 'authorization_code'
    };

    try {
        const response = await axios.post(
            'https://login.microsoftonline.com/common/oauth2/v2.0/token',
            qs.stringify(data),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        return response.data;
    } catch (error) {
        if (error.response) {
            console.error(error.response.data);
        } else {
            console.error(error.message);
        }
        return null;
    }
}

app.get('/get-token-hotmail', async (req, res) => {
    const { id, code } = req.query;

    const result = await getTokenFromCode(id, code);

    if (!result) {
        return res.json({ token: "khongco" });
    }

    return res.json({ token: result.refresh_token });
});

app.get('/read-hotmail', async (req, res) => {
    const { email, refresh_token, client_id } = req.query;
    console.log(`Nhận yêu cầu đọc email từ: ${email}`);

    try {
        const tokenResp = await axios.post(
            'https://login.microsoftonline.com/common/oauth2/v2.0/token',
            qs.stringify({
                client_id,
                refresh_token,
                grant_type: 'refresh_token',
                scope: 'https://graph.microsoft.com/Mail.Read offline_access'
            }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        const access_token = tokenResp.data.access_token;

        const mailResp = await axios.get('https://graph.microsoft.com/v1.0/me/messages?$top=5', {
            headers: {
                Authorization: `Bearer ${access_token}`
            }
        });

        let code = null;
        const messages = mailResp.data.value;
        for (const message of messages) {
            const bodyContent = message.body.content || message.bodyPreview || '';
            const match = extractVerificationCode(bodyContent)
            if (match) {
                code = match;
                break;
            }
        }

        if (code) {
            return res.json({ code: code });
        } else {
            return res.status(404).json({ error: 'No 6-digit code found in recent emails' });
        }
    } catch (error) {
        console.error('[ERROR]', error.response?.data || error.message);
        return res.status(500).json({ error: 'Failed to read email', details: error.response?.data || error.message });
    }
});

// create email unlimitmail
app.get('/create-unlimitmail', async (req, res) => {
    const token = req.query.token;
    console.log(token);

    try {
        const response = await axios.get(
            'https://unlimitmail.com/api/getAllDomain',
        );


        const index_Domain_Object = Math.floor(Math.random() * response.data.data.length) || 0;
        const randomNumber = Math.floor(Math.random() * 100000000);
        const email = `${randomString(10)}${randomNumber}@${response.data.data[index_Domain_Object].domain}`;
        const password = randomString(8);
        const createResponse = await axios.post(
            'https://unlimitmail.com/api/createEmail',
            {
                email: email,
                password: password,
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                }
            }
        );

        if (createResponse.data.data != - null) {
            return res.json({
                email: createResponse.data.data
            })
        }
    } catch (error) {
        console.error("Lỗi khi gọi API hoặc xử lý dữ liệu - unlimitmail");
        return res.json({ code: "111111" });
    }
});

// get code mail unlimitmail
app.get('/get-unlimitmail-code', async (req, res) => {
    const { email, token } = req.query;
    console.log(`Nhận yêu cầu get code từ email: ${email}`);

    if (!email || !token) {
        return res.json({ error: "Thiếu email hoặc token" });
    }

    try {
        const response = await axios.post(
            'https://unlimitmail.com/api/v1/email/getEmailContentByEmail',
            {
                email: email,
                token: token,
            },
            {
                headers: { 'Content-Type': 'application/json' }
            }
        );
        console.log(response.data);


        const emailText = response.data?.data?.[0]?.content || "";
        const code = extractVerificationCode(emailText);

        if (code) {
            return res.json({ code: code });
        }

        return res.json({ code: "111111" });
    } catch (error) {
        console.error("Lỗi khi gọi API hoặc xử lý dữ liệu - unlimitmail");
        return res.json({ code: "111111" });
    }
});


// read hotmail - api-dongvan
app.get('/get-code-api-dongvan', async (req, res) => {
    const { email, rft, password, client_id } = req.query;

    try {
        const res__1 = await axios.post('https://tools.dongvanfb.net/api/graph_code', {
            email: email,
            pass: password,
            client_id: client_id,
            refresh_token: rft,
            type: ""
        },
            {
                headers: { 'Content-Type': 'application/json' }
            })

        return res.json({ code: res__1?.code ? res__1?.code : "111111" })
    } catch (error) {
        console.error("Lỗi khi gọi API hoặc xử lý dữ liệu - dongvan api");
        return res.json({ code: "111111" })
    }
})

// Khởi động server
app.listen(PORT, () => {
    console.log(`Server chạy tại http://localhost:${PORT}`);
});

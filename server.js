const http = require('http');
const https = require('https');
const { URL } = require('url');
const fetch = require('node-fetch');
const { Agent: HttpAgent } = require('http');
const { Agent: HttpsAgent } = require('https');

const PORT = process.env.PORT || 3000;
const MAX_REDIRECTS = 20; // 最大重定向次数

// 创建自定义 Agent 以支持 SNI
const httpAgent = new HttpAgent({ keepAlive: true });
const httpsAgent = new HttpsAgent({ 
  keepAlive: true,
  rejectUnauthorized: false // 注意：在生产环境中应该验证证书
});

// 浏览器 User-Agent 列表
const BROWSER_USER_AGENTS = {
  chrome_win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  firefox_win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0'
};

// 非浏览器 UA 模式
const NON_BROWSER_AGENTS = [
  /^curl\//i,
  /^python-requests\//i,
  /^node-fetch\//i,
  /^axios\//i,
  /^wget\//i,
  /^fetch\//i,
  /^http\.rb\//i,
  /^okhttp\//i,
  /^apache-httpclient\//i,
  /^httpie\//i,
  /^java\//i,
  /^go-http-client\//i,
];

// 检查是否为非浏览器 UA
function isNonBrowserUA(ua) {
  if (!ua) return true;
  return NON_BROWSER_AGENTS.some(pattern => pattern.test(ua));
}

// 获取优化的 User-Agent
function getOptimizedUserAgent(originalUA) {
  if (originalUA && !isNonBrowserUA(originalUA)) {
    return originalUA;
  }
  return BROWSER_USER_AGENTS.chrome_win;
}

// 生成随机 IP 用于 X-Forwarded-For
function generateRandomIP() {
  return Array.from({length: 4}, () => Math.floor(Math.random() * 256)).join('.');
}

// 获取适合的 Agent
function getAgent(url, isIP) {
  if (url.protocol === 'https:') {
    // 为每个 HTTPS 请求创建新的 Agent 以确保正确的 SNI
    return new HttpsAgent({
      keepAlive: true,
      rejectUnauthorized: false, // 注意：在生产环境中应该验证证书
      servername: isIP ? undefined : url.hostname // 为 SNI 设置 servername
    });
  }
  return httpAgent;
}

// 主服务器处理函数
const server = http.createServer(async (req, res) => {
  const requestId = Date.now().toString(36) + Math.random().toString(36).substring(2, 5);
  console.log(`\n[${new Date().toISOString()}] [${requestId}] ${req.method} ${req.url}`);
  
  try {
    // 提取并验证目标 URL
    const targetUrl = decodeURIComponent(req.url.substring(1));
    if (!targetUrl.startsWith('http')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        error: 'URL 格式错误',
        message: '请使用格式: /https://example.com'
      }));
    }

    const url = new URL(targetUrl);
    const isIP = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(url.hostname);
    
    // 准备请求头
    const headers = {
      'User-Agent': getOptimizedUserAgent(req.headers['user-agent']),
      'Accept': req.headers['accept'] || '*/*',
      'Accept-Encoding': 'identity', // 禁用压缩
      'Host': url.host, // 使用原始host
      'Referer': `${url.protocol}//${url.host}`,
      ...(isIP && { 'X-Forwarded-For': generateRandomIP() }) // 对 IP 地址添加随机 XFF 头
    };

    console.log(`[${requestId}] 请求详情:`, {
      method: req.method,
      targetUrl: targetUrl,
      resolvedUrl: targetUrl, // 使用原始URL
      isIP,
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80)
    });

    let finalUrl = targetUrl; // 直接使用原始URL
    
    console.log(`[${requestId}] 正在请求: ${finalUrl}`);
    console.log(`[${requestId}] 请求头:`, JSON.stringify({
      ...headers,
      'user-agent': headers['User-Agent'].includes('Chrome') ? 'Mozilla/5.0...' : headers['User-Agent']
    }, null, 2));
    
    const startTime = Date.now();
    let response;
    
    try {
      // 创建适合的 Agent
      const agent = getAgent(url, isIP);
      
      response = await fetch(finalUrl, {
        method: req.method,
        headers,
        redirect: 'manual', // 手动处理重定向
        follow: 0, // 禁用自动重定向
        compress: false,
        timeout: 30000, // 30秒超时
        agent: (parsedUrl) => {
          return parsedUrl.protocol === 'https:' ? agent : httpAgent;
        }
      });

      // 处理重定向
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          console.log(`[${requestId}] 收到重定向: ${response.status} -> ${location}`);
          // 更新URL并重新发送请求
          finalUrl = new URL(location, finalUrl).toString();
          response = await fetch(finalUrl, {
            method: req.method,
            headers: { ...headers, Host: new URL(finalUrl).host },
            redirect: 'follow',
            follow: MAX_REDIRECTS,
            compress: false,
            agent: (parsedUrl) => {
              return parsedUrl.protocol === 'https:' ? agent : httpAgent;
            }
          });
        }
      }
      
      console.log(`[${requestId}] 收到响应: ${response.status} ${response.statusText}`);
      console.log(`[${requestId}] 响应头:`, JSON.stringify([...response.headers.entries()].reduce((acc, [key, value]) => {
        acc[key] = value;
        return acc;
      }, {}), null, 2));
      
    } catch (fetchError) {
      console.error(`[${requestId}] 请求失败:`, fetchError);
      throw new Error(`请求失败: ${fetchError.message}`);
    }

    // 设置响应头
    const responseHeaders = {};
    response.headers.forEach((value, name) => {
      // 过滤掉可能影响传输的头部
      // if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(name.toLowerCase())) {
      //   responseHeaders[name] = value;
      // }
    });
    
    // 添加 CORS 和服务器标识头
    responseHeaders['Access-Control-Allow-Origin'] = '*';
    responseHeaders['X-Proxy-Server'] = 'Node-Fetch-Proxy/1.0';
    responseHeaders['X-Request-ID'] = requestId;
    responseHeaders['X-Response-Time'] = `${Date.now() - startTime}ms`;

    console.log(`[${requestId}] 响应状态: ${response.status} ${response.statusText}`);
    
    // 发送响应头
    res.writeHead(response.status, responseHeaders);
    
    // 流式传输响应体
    response.body.pipe(res);
    
  } catch (err) {
    console.error(`[${requestId || 'unknown'}] 代理错误:`, err);
    if (!res.headersSent) {
      res.writeHead(500, { 
        'Content-Type': 'application/json',
        'X-Request-ID': requestId || 'unknown'
      });
      res.end(JSON.stringify({
        requestId: requestId || 'unknown',
        error: '代理服务器错误',
        message: err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
      }));
    }
  }
});

// 启动服务器
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 代理服务器已启动，监听端口 ${PORT}`);
  console.log(`测试地址: http://localhost:${PORT}/https://example.com`);
});

// 全局错误处理
process.on('unhandledRejection', (err) => {
  console.error('未处理的 Promise 拒绝:', err);
});

process.on('uncaughtException', (err) => {
  console.error('未捕获的异常:', err);
  process.exit(1);
});

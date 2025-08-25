const http = require('http');
const https = require('https');
const { URL } = require('url');
const dns = require('dns');
const fs = require('fs');
const os = require('os');
const { promisify } = require('util');

const PORT = process.env.PORT || 3000;
const MAX_REDIRECTS = 20;  // 最大重定向次数
const lookup = promisify(dns.lookup);  // 将dns.lookup转换为Promise形式

// 完整的现代浏览器 UA 列表
const BROWSER_USER_AGENTS = {
    chrome_win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    chrome_mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    firefox_win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    firefox_mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0',
    safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    edge_win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0',
    edge_mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0',
    opera_win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 OPR/110.0.0.0',
    opera_mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 OPR/110.0.0.0',
    ie11: 'Mozilla/5.0 (Windows NT 10.0; WOW64; Trident/7.0; rv:11.0) like Gecko'
  };

// 常见的非浏览器 UA 模式
const NON_BROWSER_AGENTS = [
    /^curl\//i,
    /^python-requests\//i,
    /^node-fetch\//i,
    /^axios\//i,
    /^java\//i,
    /^go-http-client\//i,
    /^http\.rb\//i,
    /^okhttp\//i,
    /^apache-httpclient\//i,
    /^wget\//i,
    /^fetch\//i,
    /^httpie\//i
];

// 检测是否为非浏览器 UA
function isNonBrowserUA(ua) {
if (!ua) return true;
return NON_BROWSER_AGENTS.some(pattern => pattern.test(ua));
}

// 获取优化的 UA
function getOptimizedUserAgent(originalUA) {
// 如果已经是浏览器 UA，则保留
if (originalUA && !isNonBrowserUA(originalUA)) {
    return originalUA;
}

// 根据原始 UA 的某些特征选择最匹配的浏览器
const ua = originalUA ? originalUA.toLowerCase() : '';

if (ua.includes('windows')) {
    // Windows 平台
    if (ua.includes('edge')) return BROWSER_USER_AGENTS.edge_win;
    if (ua.includes('opr') || ua.includes('opera')) return BROWSER_USER_AGENTS.opera_win;
    if (ua.includes('firefox')) return BROWSER_USER_AGENTS.firefox_win;
    if (ua.includes('trident') || ua.includes('msie')) return BROWSER_USER_AGENTS.ie11;
    return BROWSER_USER_AGENTS.chrome_win;
} else if (ua.includes('mac') || ua.includes('darwin')) {
    // Mac 平台
    if (ua.includes('safari') && !ua.includes('chrome')) return BROWSER_USER_AGENTS.safari;
    if (ua.includes('edge')) return BROWSER_USER_AGENTS.edge_mac;
    if (ua.includes('opr') || ua.includes('opera')) return BROWSER_USER_AGENTS.opera_mac;
    if (ua.includes('firefox')) return BROWSER_USER_AGENTS.firefox_mac;
    return BROWSER_USER_AGENTS.chrome_mac;
}

// 默认返回 Chrome Windows 版本
return BROWSER_USER_AGENTS.chrome_win;
}

// 规范化请求头，将所有键转为小写
function normalizeHeaders(headers) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

// 获取标准化的请求头值（不区分大小写）
function getHeader(headers, headerName) {
  const lowerHeader = headerName.toLowerCase();
  return headers[Object.keys(headers).find(k => k.toLowerCase() === lowerHeader)];
}

// 过滤请求头
function filterHeaders(originalHeaders) {
  const headers = normalizeHeaders(originalHeaders);
  
  // 需要移除的请求头
  const headersToRemove = [
    // 'host',
    // 'connection',
    // 'content-length',
    // 'transfer-encoding',
    // 'accept-encoding',
    // 'referer',
    // 'origin'
  ];
  
  headersToRemove.forEach(header => {
    delete headers[header];
  });
  
  return headers;
}

// 创建深拷贝的工具函数，处理特殊对象
function deepCopy(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  
  // 处理特殊对象
  if (obj.agent) {
    const result = { ...obj };
    // 保留 agent 引用，不进行深拷贝
    result.agent = obj.agent;
    return result;
  }
  
  // 处理数组
  if (Array.isArray(obj)) {
    return obj.map(item => deepCopy(item));
  }
  
  // 处理普通对象
  const result = {};
  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      result[key] = deepCopy(obj[key]);
    }
  }
  return result;
}

// 创建请求配置
function createRequestOptions(options) {
  const isHttps = options.protocol === 'https:';
  const originalUA = options.headers && (options.headers['user-agent'] || options.headers['User-Agent']);
  const userAgent = getOptimizedUserAgent(originalUA);
  
  // 创建浅拷贝，避免修改原始 options
  const requestOptions = { ...options };
  
  // 处理 headers
  requestOptions.headers = {
    ...options.headers,
    'host': options.hostname,
    'user-agent': userAgent,
    'accept': options.headers?.accept || '*/*',
    'accept-encoding': 'identity'
  };

  // 设置 HTTPS 特定选项
  if (isHttps) {
    requestOptions.servername = options.hostname;
    requestOptions.rejectUnauthorized = false;
  }

  // 记录最终配置（排除 agent 对象）
  const logOptions = { ...requestOptions };
  delete logOptions.agent;  // 不记录 agent 对象
  
  console.log('创建请求配置:', {
    ...logOptions,
    protocol: isHttps ? 'HTTPS' : 'HTTP',
    port: requestOptions.port || (isHttps ? 443 : 80),
    redirectCount: options.redirectCount || 0
  });

  return requestOptions;
}

// 创建代理请求
async function createProxyRequest(options, res, redirectCount = 0) {
  try {
    // 使用dns.lookup解析域名
    try {
      const { address } = await lookup(options.hostname);
      console.log(`已解析 ${options.hostname} 的IP地址: ${address}`);
      //options.hostname = address;  // 使用解析后的IP地址
    } catch (dnsError) {
      console.error('DNS解析失败:', dnsError);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          error: 'DNS解析失败',
          message: `无法解析主机名: ${options.hostname}`
        }));
      }
      return;
    }

    if (redirectCount >= MAX_REDIRECTS) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        error: '重定向次数过多',
        message: `超过最大重定向次数: ${MAX_REDIRECTS}`
      }));
    }

    const isHttps = options.protocol === 'https:';
    const client = isHttps ? https : http;

    // 创建并验证请求配置
    const requestOptions = createRequestOptions({
      ...options,
      redirectCount
    });

    // 创建请求
    const proxyRequest = client.request(requestOptions, (proxyResponse) => {
      console.log(`收到响应: ${proxyResponse.statusCode}`, {
        protocol: isHttps ? 'HTTPS' : 'HTTP',
        hostname: options.hostname,
        statusCode: proxyResponse.statusCode,
        headers: proxyResponse.headers,
        redirectLocation: proxyResponse.headers.location,
        useSNI: isHttps ? '是' : '不适用'
      });

      // 处理重定向
      if ([301, 302, 303, 307, 308].includes(proxyResponse.statusCode)) {
        const location = proxyResponse.headers.location;
        if (!location) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            error: '重定向错误',
            message: '收到重定向响应但缺少Location头'
          }));
        }

        // 解析重定向URL
        let newUrl;
        try {
          newUrl = new URL(location, `${isHttps ? 'https' : 'http'}://${options.hostname}`);
          console.log(`重定向到: ${newUrl.href}`);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            error: '无效的重定向URL',
            message: err.message
          }));
        }

        // 更新请求选项
        const newOptions = {
          ...options,
          hostname: newUrl.hostname,
          port: newUrl.port || (newUrl.protocol === 'https:' ? 443 : 80),
          path: newUrl.pathname + newUrl.search,
          headers: {
            ...options.headers,
            host: newUrl.host
          },
          protocol: newUrl.protocol
        };
        
        // 创建新的请求
        return createProxyRequest(newOptions, res, redirectCount + 1);
      }

      // 复制响应头，但过滤掉不安全的头
      const responseHeaders = { ...proxyResponse.headers };
      
      // 需要移除的响应头
      const headersToRemove = [
        'connection',
        'transfer-encoding',
        'content-encoding',  // 因为我们不处理压缩，所以移除内容编码头
        'content-length'     // 因为内容可能被修改，所以需要重新计算长度
      ];
      
      // headersToRemove.forEach(header => {
      //  delete responseHeaders[header];
      //  delete responseHeaders[header.toLowerCase()];
      // });

      // 设置响应头
      res.writeHead(proxyResponse.statusCode || 500, responseHeaders);

      // 直接管道传输响应体
      proxyResponse.pipe(res);

      // 记录请求完成
      proxyResponse.on('end', () => {
        console.log(`请求完成: ${options.hostname}${options.path} - ${proxyResponse.statusCode}`);
      });

      proxyResponse.on('error', (err) => {
        console.error('接收响应时出错:', err);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: '接收响应时出错',
            message: err.message
          }));
        }
      });
    });

    proxyRequest.on('error', (err) => {
      console.error('代理请求错误:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: '代理请求失败',
          message: err.message
        }));
      }
    });

    // 设置请求超时
    proxyRequest.setTimeout(30000, () => {
      proxyRequest.destroy(new Error('请求超时'));
    });

    // 发送请求
    if (options.body) {
      proxyRequest.write(options.body);
    }
    proxyRequest.end();
    
  } catch (err) {
    console.error('创建代理请求时出错:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: '内部服务器错误',
        message: err.message
      }));
    }
  }
}

const server = http.createServer(async (req, res) => {
  console.log(`\n[${new Date().toLocaleString()}] ${req.method} ${req.url}`);
  
  try {
    // 解析目标URL
    const targetUrl = req.url.startsWith('/http') ? req.url.substring(1) : req.url;
    console.log('目标URL:', targetUrl);
    
    if (!targetUrl.startsWith('http')) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('使用方法: /https://example.com');
    }
    
    const targetUrlObj = new URL(targetUrl);
    const isHttps = targetUrlObj.protocol === 'https:';
    
    // 规范化请求头
    const normalizedHeaders = normalizeHeaders(req.headers);
    const requestHeaders = {
        ...filterHeaders(normalizedHeaders),  // 使用过滤后的头
        'host': targetUrlObj.host,
        'user-agent': getHeader(normalizedHeaders, 'user-agent') || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'accept': getHeader(normalizedHeaders, 'accept') || '*/*',
        'accept-encoding': 'identity',  // 显式设置不压缩
        'referer': getHeader(normalizedHeaders, 'referer') || targetUrlObj.href,
      }
    
    // 准备请求选项
    const options = {
      hostname: targetUrlObj.hostname,
      port: targetUrlObj.port || (isHttps ? 443 : 80),
      path: targetUrlObj.pathname + targetUrlObj.search,
      method: req.method,
      protocol: targetUrlObj.protocol,
      headers: requestHeaders,
      // 确保HTTPS请求使用SNI
      servername: isHttps ? targetUrlObj.hostname : undefined,
      // 禁用证书验证（仅限开发环境）
      rejectUnauthorized: false,
      // 增加超时时间
      timeout: 30000,
      // 启用keep-alive
      agent: isHttps ? 
        new https.Agent({ 
          keepAlive: true,
          servername: targetUrlObj.hostname  // 确保SNI使用正确的主机名
        }) : 
        new http.Agent({ keepAlive: true })
    };

    console.log('请求选项:', {
      method: options.method,
      url: `${options.protocol}//${options.hostname}${options.path}`,
      headers: options.headers,
      isHttps,
      servername: options.servername
    });
    
    // 创建并发送请求
    const proxyRequest = await createProxyRequest(options, res);
    if (!proxyRequest) return;  // 如果创建请求失败则直接返回
    
    // 转发请求体（如果有）
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      req.pipe(proxyRequest);
    } else {
      proxyRequest.end();
    }
    
  } catch (err) {
    console.error('处理请求时出错:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: '内部服务器错误',
        message: err.message
      }));
    }
  }
});

// 错误处理
server.on('error', (err) => {
  console.error('服务器错误:', err);
});

// 启动服务器
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 代理服务器已启动`);
  console.log(`   本地地址: http://localhost:${PORT}`);
  console.log(`   网络地址: http://${os.networkInterfaces().eth0?.[0]?.address || '0.0.0.0'}:${PORT}`);
  console.log(`\n使用示例:`);
  console.log(`   http://localhost:${PORT}/https://example.com`);
  console.log(`   http://localhost:${PORT}/https://github.com`);
});

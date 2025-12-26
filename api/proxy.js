const cheerio = require('cheerio'); // Для парсинга HTML
const { URL } = require('url'); // Для работы с URL
const { PassThrough } = require('stream'); // Для стриминга ответов

// --- Вспомогательные функции ---

// Функция для безопасного получения абсолютного URL
function getAbsoluteUrl(relativeOrAbsoluteUrl, baseUrl) {
    try {
        return new URL(relativeOrAbsoluteUrl, baseUrl).href;
    } catch (e) {
        console.warn(`Invalid URL encountered: ${relativeOrAbsoluteUrl}, base: ${baseUrl}. Error: ${e.message}`);
        return null; // Возвращаем null, если URL некорректен
    }
}

// Функция для проксирования URL через наш сервис
function createProxiedUrl(originalAbsoluteUrl, req) {
    if (!originalAbsoluteUrl) return '';
    // Проверяем, если это URL нашего прокси, то не проксируем его снова
    if (originalAbsoluteUrl.startsWith(`${req.protocol}://${req.headers.host}/api/proxy`)) {
        return originalAbsoluteUrl;
    }
    return `${req.protocol}://${req.headers.host}/api/proxy?url=${encodeURIComponent(originalAbsoluteUrl)}`;
}

// --- Основная Serverless функция ---
module.exports = async (req, res) => {
    const { url: targetUrlParam } = req.query; // Получаем URL от клиента
    if (!targetUrlParam) {
        return res.status(400).send('URL parameter is required.');
    }

    let targetUrl;
    try {
        targetUrl = new URL(targetUrlParam); // Парсим целевой URL
    } catch (e) {
        return res.status(400).send(`Invalid target URL: ${targetUrlParam}`);
    }

    const originalHost = targetUrl.origin; // Оригинальный домен целевого сайта

    try {
        // 1. Делаем запрос к целевому сайту
        const response = await fetch(targetUrl.href, {
            headers: {
                // Притворяемся обычным браузером
                'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': req.headers['accept'] || '*/*',
                'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
                // НЕ ПЕРЕДАВАЙТЕ COOKIE напрямую, это небезопасно и сложно
            },
            redirect: 'follow', // Следовать за редиректами
        });

        // 2. Обработка ошибок HTTP
        if (!response.ok) {
            return res.status(response.status).send(`Failed to fetch ${targetUrl.href}: ${response.statusText}`);
        }

        const originalContentType = response.headers.get('Content-Type') || '';
        const isHtml = originalContentType.includes('text/html');
        const isCss = originalContentType.includes('text/css');
        const isJavascript = originalContentType.includes('application/javascript') || originalContentType.includes('text/javascript');

        // 3. Установка заголовков для ответа клиенту
        const responseHeaders = {};
        for (const [key, value] of response.headers.entries()) {
            const lowerKey = key.toLowerCase();
            // Удаляем заголовки, которые могут мешать или быть небезопасными
            if (!['content-security-policy', 'x-frame-options', 'x-content-type-options', 'strict-transport-security', 'set-cookie', 'location'].includes(lowerKey)) {
                responseHeaders[key] = value;
            }
        }
        // Обязательно устанавливаем CORS для нашего прокси
        responseHeaders['Access-Control-Allow-Origin'] = '*';
        responseHeaders['Content-Type'] = originalContentType; // Передаем оригинальный Content-Type

        // Если это редирект, то нам нужно его проксировать
        if (response.status >= 300 && response.status < 400 && response.headers.get('Location')) {
            const redirectUrl = getAbsoluteUrl(response.headers.get('Location'), targetUrl.href);
            if (redirectUrl) {
                // Отправляем редирект на наш прокси с новым URL
                res.setHeader('Location', createProxiedUrl(redirectUrl, req));
                return res.status(response.status).end();
            }
        }
        
        let processedContent = await response.text();

        // 4. Перезапись URL в контенте
        if (isHtml) {
            const $ = cheerio.load(processedContent, { decodeEntities: false });

            // Переписываем BASE URL, чтобы все относительные ссылки работали правильно
            // Это временно, пока мы не перепишем все явно
            $('head').prepend(`<base href="${originalHost}/">`);


            // Элементы и атрибуты для перезаписи
            const elementsToRewrite = {
                'a': 'href',
                'img': 'src',
                'script': 'src',
                'link[rel="stylesheet"]': 'href',
                'form': 'action',
                'source': 'src',
                'video': 'src',
                'audio': 'src',
                'track': 'src',
                'iframe': 'src',
                'meta[property="og:image"]': 'content', // Открытый граф, например
                'meta[name="twitter:image"]': 'content',
                // Добавьте сюда другие, если найдете
            };

            for (const selector in elementsToRewrite) {
                const attribute = elementsToRewrite[selector];
                $(selector).each((i, el) => {
                    let value = $(el).attr(attribute);
                    if (value) {
                        if (value.startsWith('data:') || value.startsWith('#')) { // Игнорируем data-URI и якоря
                            return;
                        }
                        const absoluteUrl = getAbsoluteUrl(value, targetUrl.href);
                        if (absoluteUrl) {
                            $(el).attr(attribute, createProxiedUrl(absoluteUrl, req));
                        }
                    }
                });
            }

            // Переписываем URL в инлайновых стилях (очень упрощенно)
            $('*').each((i, el) => {
                const style = $(el).attr('style');
                if (style && style.includes('url(')) {
                    const newStyle = style.replace(/url\(['"]?(.*?)['"]?\)/g, (match, urlInCss) => {
                        const absoluteUrl = getAbsoluteUrl(urlInCss, targetUrl.href);
                        return absoluteUrl ? `url('${createProxiedUrl(absoluteUrl, req)}')` : match;
                    });
                    $(el).attr('style', newStyle);
                }
            });

            // Удаляем мета-теги, которые могут мешать
            $('meta[http-equiv="Content-Security-Policy"]').remove();
            $('meta[name="referrer"]').remove();
            $('meta[name="robots"][content*="noindex"]').remove(); // Чтобы страница не скрывалась

            // 5. Внедрение клиентского JS (самая сложная часть!)
            $('head').append(`
                <script>
                    (function() {
                        const PROXY_BASE_URL = '${req.protocol}://${req.headers.host}/api/proxy?url=';
                        const ORIGINAL_BASE_URL = '${originalHost}';

                        function getAbsoluteUrlFromPage(url) {
                            const a = document.createElement('a');
                            a.href = url;
                            return a.href;
                        }

                        function shouldProxyUrl(url) {
                            // Проксируем только URL, которые не ведут на наш собственный прокси
                            return url && !url.startsWith(PROXY_BASE_URL) && !url.startsWith('blob:') && !url.startsWith('data:');
                        }

                        function proxifyUrl(url) {
                            if (!shouldProxyUrl(url)) {
                                return url;
                            }
                            const absoluteUrl = getAbsoluteUrlFromPage(url);
                            // Если абсолютный URL ведет на оригинальный домен, проксируем его
                            if (absoluteUrl.startsWith(ORIGINAL_BASE_URL)) {
                                return PROXY_BASE_URL + encodeURIComponent(absoluteUrl);
                            }
                            return url; // Если это внешний домен, возможно, проксировать не нужно или он будет заблокирован
                        }

                        // --- Перехват fetch ---
                        const originalFetch = window.fetch;
                        window.fetch = function(input, init) {
                            let proxiedInput = input;
                            if (typeof input === 'string') {
                                proxiedInput = proxifyUrl(input);
                            } else if (input instanceof Request) {
                                proxiedInput = new Request(proxifyUrl(input.url), input);
                            }
                            return originalFetch(proxiedInput, init);
                        };

                        // --- Перехват XMLHttpRequest ---
                        const originalXHR = window.XMLHttpRequest;
                        window.XMLHttpRequest = function() {
                            const xhr = new originalXHR();
                            const originalOpen = xhr.open;
                            xhr.open = function(method, url, async, user, password) {
                                const proxiedUrl = proxifyUrl(url);
                                originalOpen.call(this, method, proxiedUrl, async, user, password);
                            };
                            return xhr;
                        };

                        // --- Перехват навигации (ссылок и форм) ---
                        document.addEventListener('click', function(event) {
                            let target = event.target;
                            while (target && target.tagName !== 'A') {
                                target = target.parentNode;
                            }
                            if (target && target.tagName === 'A' && target.href) {
                                event.preventDefault(); // Предотвращаем стандартное действие
                                window.location.href = proxifyUrl(target.href); // Перенаправляем через наш прокси
                            }
                        }, true); // true для фазы захвата

                        document.addEventListener('submit', function(event) {
                            const form = event.target;
                            if (form && form.tagName === 'FORM' && form.action) {
                                event.preventDefault();
                                const originalAction = form.action;
                                const originalMethod = form.method || 'GET';
                                const formData = new FormData(form);

                                let queryParams = [];
                                for (let [name, value] of formData.entries()) {
                                    queryParams.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
                                }
                                
                                const proxiedAction = proxifyUrl(originalAction);
                                if (originalMethod.toUpperCase() === 'GET') {
                                    window.location.href = `${proxiedAction}&${queryParams.join('&')}`;
                                } else {
                                    // Для POST запросов через прокси нужно отправлять через fetch
                                    // Это сильно усложняется, т.к. прокси должен быть способен принимать POST запросы
                                    // Для начала можно просто отправить через GET, если это не критично
                                    console.warn('POST forms are not fully supported yet, redirecting as GET.');
                                    window.location.href = `${proxiedAction}&${queryParams.join('&')}`;
                                }
                            }
                        }, true);

                        // --- Перехват window.location (частично) ---
                        Object.defineProperty(window, 'location', {
                            get: () => {
                                // Возвращаем объект, который имитирует location, но с проксированным href
                                return {
                                    ...Object.fromEntries(Object.entries(window.location)), // Копируем все свойства
                                    href: proxifyUrl(window.location.href), // Проксированный href
                                    replace: (url) => { window.location.replace(proxifyUrl(url)); },
                                    assign: (url) => { window.location.assign(proxifyUrl(url)); },
                                    toString: () => proxifyUrl(window.location.href)
                                };
                            },
                            set: (url) => {
                                window.location.href = proxifyUrl(url);
                            }
                        });


                        // --- Перехват createElement для динамических элементов ---
                        const originalCreateElement = document.createElement;
                        document.createElement = function(tagName, options) {
                            const element = originalCreateElement.call(this, tagName, options);
                            // Если это IMG, SCRIPT, LINK, IFRAME - проксируем их атрибуты при установке
                            if (['IMG', 'SCRIPT', 'LINK', 'IFRAME', 'SOURCE', 'VIDEO', 'AUDIO', 'TRACK'].includes(tagName.toUpperCase())) {
                                const attribute = (tagName.toUpperCase() === 'LINK') ? 'href' : 'src';
                                Object.defineProperty(element, attribute, {
                                    set: function(value) {
                                        this.setAttribute(attribute, proxifyUrl(value));
                                    },
                                    get: function() {
                                        return this.getAttribute(attribute);
                                    }
                                });
                            } else if (tagName.toUpperCase() === 'A') {
                                Object.defineProperty(element, 'href', {
                                    set: function(value) {
                                        this.setAttribute('href', proxifyUrl(value));
                                    },
                                    get: function() {
                                        return this.getAttribute('href');
                                    }
                                });
                            } else if (tagName.toUpperCase() === 'FORM') {
                                Object.defineProperty(element, 'action', {
                                    set: function(value) {
                                        this.setAttribute('action', proxifyUrl(value));
                                    },
                                    get: function() {
                                        return this.getAttribute('action');
                                    }
                                });
                            }
                            return element;
                        };

                        // Перехват document.write/writeln
                        const originalDocWrite = document.write;
                        document.write = function(htmlString) {
                            // Очень грубый перехват, чтобы не ломать совсем
                            const modifiedHtml = htmlString.replace(/(\b(?:src|href|action)=")([^"]*)(")/gi, (match, prefix, url, suffix) => {
                                return prefix + proxifyUrl(url) + suffix;
                            });
                            originalDocWrite.call(this, modifiedHtml);
                        };
                        const originalDocWriteln = document.writeln;
                        document.writeln = function(htmlString) {
                            const modifiedHtml = htmlString.replace(/(\b(?:src|href|action)=")([^"]*)(")/gi, (match, prefix, url, suffix) => {
                                return prefix + proxifyUrl(url) + suffix;
                            });
                            originalDocWriteln.call(this, modifiedHtml);
                        };

                        // Дополнительно:
                        // Перехват CSSStyleDeclaration.setProperty, CSSStyleDeclaration.cssText
                        // Перехват iframe.contentWindow.location
                        // Перехват WebSocket
                        // Обработка document.cookie (очень сложно и опасно)
                        // Обработка localStorage / sessionStorage (очень сложно и опасно)
                    })();
                </script>
            `);

            processedContent = $.html(); // Получаем измененный HTML
        } else if (isCss) {
            // Переписываем URL в CSS-файлах
            processedContent = processedContent.replace(/url\(['"]?(.*?)['"]?\)/g, (match, urlInCss) => {
                const absoluteUrl = getAbsoluteUrl(urlInCss, targetUrl.href);
                return absoluteUrl ? `url('${createProxiedUrl(absoluteUrl, req)}')` : match;
            });
        }
        // !!! Проксирование JavaScript файлов - это САМАЯ СЛОЖНАЯ ЧАСТЬ
        // Требует парсинга JS-кода и перезаписи всех строковых литералов,
        // которые могут быть URL. Это почти нереализуемо без полноценного JS-парсера/транспайлера.
        // Пока просто возвращаем JS как есть, полагаясь на клиентский перехват fetch/XHR.
        // else if (isJavascript) {
        //    // Здесь нужна сложная логика парсинга JS
        // }


        res.writeHead(response.status, responseHeaders);
        res.end(processedContent);

    } catch (error) {
        console.error('Full Proxy Error:', error);
        // Если ошибка связана с SSL сертификатом или сетью - это часто связано с целевым сайтом.
        // Попробуйте перехватить конкретные ошибки и дать более информативное сообщение.
        res.status(500).send(`Error proxying request to ${targetUrl.href}: ${error.message}`);
    }
};

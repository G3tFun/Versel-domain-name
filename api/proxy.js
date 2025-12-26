const cheerio = require('cheerio'); // Импортируем cheerio

module.exports = async (req, res) => {
    const { url: targetUrl } = req.query; // Целевой URL
    const { type: contentTypeOverride } = req.query; // Для указания типа контента, если необходимо

    if (!targetUrl) {
        return res.status(400).send('URL parameter is required.');
    }

    try {
        const response = await fetch(targetUrl);

        if (!response.ok) {
            // Если целевой сайт вернул 404, то и мы возвращаем 404
            return res.status(response.status).send(`Failed to fetch: ${response.statusText} from ${targetUrl}`);
        }

        const originalContentType = response.headers.get('Content-Type') || 'text/html';
        let content = await response.text();

        // Проверяем, нужно ли нам обрабатывать HTML
        // Если это не HTML, то просто пробрасываем контент как есть
        if (originalContentType.includes('text/html') || contentTypeOverride === 'html') {
            const $ = cheerio.load(content, { decodeEntities: false }); // decodeEntities: false, чтобы не ломать HTML-сущности

            // BASE Href:
            // Важно добавить <base href="...">, чтобы относительные пути (если они не переписаны)
            // правильно ссылались на оригинальный домен.
            // Однако, для полного проксирования лучше переписывать все пути.
            // Давайте попробуем переписать большинство путей через наш прокси.

            // Список элементов и атрибутов для переписывания
            const attributesToRewrite = {
                'a': 'href',
                'img': 'src',
                'script': 'src',
                'link[rel="stylesheet"]': 'href',
                'form': 'action',
                'source': 'src',
                'video': 'src',
                'audio': 'src',
                'track': 'src',
            };

            for (const selector in attributesToRewrite) {
                const attribute = attributesToRewrite[selector];
                $(selector).each((i, el) => {
                    let value = $(el).attr(attribute);
                    if (value) {
                        // Пропускаем data-URI и пустые ссылки
                        if (value.startsWith('data:')) {
                            return;
                        }

                        // Если это относительный URL, преобразуем его в абсолютный
                        let absoluteUrl;
                        try {
                            absoluteUrl = new URL(value, targetUrl).href;
                        } catch (e) {
                            // Если URL некорректный, оставляем как есть или пропускаем
                            console.warn(`Invalid URL found: ${value} in ${targetUrl}`);
                            return;
                        }

                        // Переписываем URL так, чтобы он проходил через наш прокси
                        // Обратите внимание: `/api/proxy` должен быть доступен
                        $(el).attr(attribute, `/api/proxy?url=${encodeURIComponent(absoluteUrl)}`);
                    }
                });
            }

            // Дополнительно: обработка инлайновых стилей (background-image: url(...))
            // Это гораздо сложнее, так как CSS нужно парсить.
            // Для начала можно пропустить.

            // Дополнительно: удалить или изменить CSP (Content-Security-Policy)
            // Если целевой сайт отправляет строгий CSP, он может блокировать выполнение
            // или загрузку ресурсов, даже если они проксированы.
            $('meta[http-equiv="Content-Security-Policy"]').remove();
            $('meta[name="referrer"]').remove(); // Иногда может быть полезно удалить Referrer-Policy

            // Дополнительно: удалить скрипты, если они вызывают проблемы
            // Это радикальная мера, но может помочь для некоторых сайтов.
            // $('script').remove();

            content = $.html(); // Получаем измененный HTML
        }

        // Заголовки ответа
        res.setHeader('Access-Control-Allow-Origin', '*'); // Разрешаем CORS для нашего прокси

        // Устанавливаем Content-Type, если это не HTML или если мы хотим быть точными
        if (contentTypeOverride) {
            res.setHeader('Content-Type', contentTypeOverride);
        } else {
            res.setHeader('Content-Type', originalContentType);
        }

        res.send(content);

    } catch (error) {
        console.error('Proxy error:', error);
        res.status(500).send('Error proxying request.');
    }
};

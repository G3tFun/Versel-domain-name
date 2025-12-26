// api/proxy.js
module.exports = async (req, res) => {
    const { url } = req.query; // Получаем целевой URL из параметра запроса

    if (!url) {
        return res.status(400).send('URL parameter is required.');
    }

    try {
        const response = await fetch(url);

        // Обработка ошибок HTTP
        if (!response.ok) {
            return res.status(response.status).send(`Failed to fetch: ${response.statusText}`);
        }

        // Устанавливаем заголовки, чтобы предотвратить CORS на прокси-стороне
        // и передаем тип контента. Будьте осторожны с заголовками!
        // Для реального проксирования лучше передавать все заголовки
        // от оригинального ответа, кроме тех, что влияют на безопасность
        // или являются Hop-by-Hop.
        res.setHeader('Access-Control-Allow-Origin', '*'); // Разрешаем всем доменам доступ к этому прокси
        res.setHeader('Content-Type', response.headers.get('Content-Type') || 'text/html'); // Передаем оригинальный Content-Type

        // Возвращаем содержимое целевой страницы
        const text = await response.text();
        res.send(text);

    } catch (error) {
        console.error('Proxy error:', error);
        res.status(500).send('Error proxying request.');
    }
};

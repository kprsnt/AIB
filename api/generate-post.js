// Import necessary libraries
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Octokit } = require('@octokit/rest');
const { createHmac } = require('crypto');

// dotenv is used for local development to load environment variables from a .env file.
// On Vercel, these variables are set in the project settings and loaded automatically.
require('dotenv').config();

// --- INITIALIZE CLIENTS AND CONFIG ---
const octokit = new Octokit({ auth: process.env.GITHUB_PAT });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// GitHub repository details from environment variables
const owner = process.env.GITHUB_REPO_OWNER;
const repo = process.env.GITHUB_REPO_NAME;
const webhookSecret = process.env.WEBHOOK_SECRET;

// --- MAIN SERVERLESS FUNCTION HANDLER ---
module.exports = async (req, res) => {
    console.log('Received a request to /api/generate-post');

    // 1. VERIFY THE WEBHOOK SIGNATURE
    // This is a security measure to ensure the request is genuinely from GitHub.
    try {
        const signature = req.headers['x-hub-signature-256'];
        if (!signature) {
            console.error('Signature missing from request.');
            return res.status(401).send('Unauthorized: Signature missing.');
        }

        const hmac = createHmac('sha256', webhookSecret);
        // Vercel automatically parses the JSON body, so we must stringify it again to match GitHub's signature.
        hmac.update(JSON.stringify(req.body));
        const calculatedSignature = `sha256=${hmac.digest('hex')}`;

        if (signature !== calculatedSignature) {
            console.error('Webhook signature does not match.');
            return res.status(401).send('Unauthorized: Invalid signature.');
        }
        console.log('Webhook signature verified successfully.');
    } catch (error) {
        console.error('Error during webhook signature verification:', error);
        return res.status(500).send('Internal Server Error during verification.');
    }

    // 2. HANDLE GITHUB PING EVENT
    // When you create a webhook, GitHub sends a 'ping' to test the connection.
    if (req.headers['x-github-event'] === 'ping') {
        console.log('Received GitHub ping event. Connection is successful.');
        return res.status(200).send('Ping event received successfully.');
    }

    // 3. CHECK FOR A PUSH TO THE MAIN BRANCH
    const pushRef = req.body.ref;
    console.log(`Push event for ref: ${pushRef}`);
    if (pushRef !== 'refs/heads/main' && pushRef !== 'refs/heads/master') {
        console.log('Push was not to the main/master branch, skipping.');
        return res.status(200).send('Push was not to the main/master branch, skipping.');
    }

    try {
        console.log('Starting post generation process...');

        // 4. GET LATEST COMMIT AND FILE STATES
        const latestCommitSha = req.body.after;
        console.log(`Processing commit SHA: ${latestCommitSha}`);

        // Fetch ideas.md content
        const { data: ideasFile } = await octokit.repos.getContent({ owner, repo, path: 'ideas.md', ref: latestCommitSha });
        const ideasContent = Buffer.from(ideasFile.content, 'base64').toString('utf8');

        // Fetch existing posts to avoid re-generating them
        const { data: existingPostsData } = await octokit.repos.getContent({ owner, repo, path: 'public/posts', ref: latestCommitSha });
        const existingPostFiles = existingPostsData.map(file => file.name);
        console.log(`Found ${existingPostFiles.length} existing posts.`);

        // 5. PARSE IDEAS AND IDENTIFY NEW ONES
        const newIdeas = parseIdeas(ideasContent, existingPostFiles);
        if (newIdeas.length === 0) {
            console.log('No new ideas to process.');
            return res.status(200).send('No new ideas found.');
        }
        console.log(`Found ${newIdeas.length} new ideas to process:`, newIdeas.map(i => i.topic));

        // 6. GENERATE POSTS FOR NEW IDEAS
        const newFilesToCommit = [];
        const { data: templateFile } = await octokit.repos.getContent({ owner, repo, path: 'templates/post-template.html', ref: latestCommitSha });
        const postTemplate = Buffer.from(templateFile.content, 'base64').toString('utf8');

        for (const idea of newIdeas) {
            console.log(`--- Generating post for: ${idea.topic} ---`);
            const prompt = `You are an expert blog writer who writes clear, engaging, and well-structured articles. Your task is to convert the following topic and analysis points into a complete blog post. The output format MUST be clean, semantic HTML. Do not include <html>, <head>, or <body> tags. Only provide the article content itself, starting with an <h1> for the title. Use <p>, <h2>, <h3>, <ul>, <li>, and <strong> tags appropriately to structure the article.

            **Topic:**
            ${idea.topic}

            **Analysis & Key Points to Include:**
            ${idea.analysis}

            Generate the HTML content for the blog post now.`;

            const model = genAI.getGenerativeModel({ model: "gemini-pro" });
            const result = await model.generateContent(prompt);
            const response = await result.response;
            const generatedHtml = response.text();
            
            const postContent = postTemplate
                .replace('{{POST_TITLE}}', idea.topic)
                .replace('{{POST_CONTENT}}', generatedHtml);

            newFilesToCommit.push({
                path: `public/posts/${idea.filename}`,
                content: postContent,
            });
            console.log(`Created content for ${idea.filename}`);
        }

        // 7. UPDATE INDEX.HTML
        console.log('Updating index.html...');
        const allPostFiles = [...existingPostFiles, ...newIdeas.map(i => i.filename)];
        const uniquePostFiles = [...new Set(allPostFiles)];
        uniquePostFiles.sort().reverse(); // Sort posts, newest first if dated, otherwise alphabetically reversed

        const postLinks = uniquePostFiles
            .map(filename => {
                const linkText = filename.replace('.html', '').replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
                return `      <li><a href="/posts/${filename}">${linkText}</a></li>`;
            })
            .join('\n');

        const { data: indexFile } = await octokit.repos.getContent({ owner, repo, path: 'public/index.html', ref: latestCommitSha });
        const indexContent = Buffer.from(indexFile.content, 'base64').toString('utf8');
        
        // Use comment placeholders for robust replacement
        const updatedIndexContent = indexContent.replace(
            /<!-- POSTS_LIST_START -->[\s\S]*<!-- POSTS_LIST_END -->/,
            `<!-- POSTS_LIST_START -->\n    <ul>\n${postLinks}\n    </ul>\n    <!-- POSTS_LIST_END -->`
        );

        newFilesToCommit.push({ path: 'public/index.html', content: updatedIndexContent });
        console.log('index.html updated and added to commit list.');

        // 8. COMMIT NEW FILES TO GITHUB
        console.log('Starting commit process...');
        const { data: latestCommit } = await octokit.git.getCommit({ owner, repo, commit_sha: latestCommitSha });
        const baseTreeSha = latestCommit.tree.sha;

        const blobs = await Promise.all(
            newFilesToCommit.map(file =>
                octokit.git.createBlob({ owner, repo, content: file.content, encoding: 'utf-8' })
                    .then(blob => ({ path: file.path, mode: '100644', type: 'blob', sha: blob.data.sha }))
            )
        );

        const { data: newTree } = await octokit.git.createTree({ owner, repo, base_tree: baseTreeSha, tree: blobs });
        
        const commitMessage = newIdeas.length === 1
            ? `feat: Add post "${newIdeas[0].topic}"`
            : `feat: Add ${newIdeas.length} new blog posts via Gemini`;

        const { data: newCommit } = await octokit.git.createCommit({
            owner,
            repo,
            message: commitMessage,
            tree: newTree.sha,
            parents: [latestCommitSha],
        });

        await octokit.git.updateRef({ owner, repo, ref: 'heads/main', sha: newCommit.sha });
        console.log('Successfully updated ref for heads/main.');

        console.log('--- Post generation process completed successfully! ---');
        res.status(200).send('Processing completed. New posts added.');

    } catch (error) {
        console.error('--- An error occurred during the post generation process ---');
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        if (error.response) {
            console.error('Error response data:', error.response.data);
        }
        res.status(500).send('Internal Server Error');
    }
};

// --- HELPER FUNCTIONS ---

function slugify(text) {
    const a = 'àáâäæãåāăąçćčđďèéêëēėęěğǵḧîïíīįìłḿñńǹňôöòóœøōõőṕŕřßśšşșťțûüùúūǘůűųẃẍÿýžźż·/_,:;'
    const b = 'aaaaaaaaaacccddeeeeeeeegghiiiiiilmnnnnoooooooooprrssssssttuuuuuuuuuwxyyzzz------'
    const p = new RegExp(a.split('').join('|'), 'g')

    return text.toString().toLowerCase()
        .replace(/\s+/g, '-') // Replace spaces with -
        .replace(p, c => b.charAt(a.indexOf(c))) // Replace special characters
        .replace(/&/g, '-and-') // Replace & with 'and'
        .replace(/[^\w\-]+/g, '') // Remove all non-word chars
        .replace(/\-\-+/g, '-') // Replace multiple - with single -
        .replace(/^-+/, '') // Trim - from start of text
        .replace(/-+$/, '') // Trim - from end of text
}

function parseIdeas(content, existingPostFiles) {
    const ideas = content.split('---').filter(idea => idea.trim() !== '');
    const newIdeas = [];
    for (const idea of ideas) {
        const topicMatch = idea.match(/TOPIC:\s*(.*)/i);
        const analysisMatch = idea.match(/ANALYSIS:\s*([\s\S]*)/i);
        if (topicMatch && topicMatch[1]) {
            const topic = topicMatch[1].trim();
            const analysis = analysisMatch ? analysisMatch[1].trim() : '';
            const filename = `${slugify(topic)}.html`;
            if (!existingPostFiles.includes(filename)) {
                newIdeas.push({ topic, analysis, filename });
            }
        }
    }
    return newIdeas;
}

// Import necessary libraries
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Octokit } = require('@octokit/rest');
const { createHmac } = require('crypto');
require('dotenv').config();

// Initialize clients
const octokit = new Octokit({ auth: process.env.GITHUB_PAT });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// GitHub repository details from environment variables
const owner = process.env.GITHUB_REPO_OWNER;
const repo = process.env.GITHUB_REPO_NAME;
const webhookSecret = process.env.WEBHOOK_SECRET;

// Main serverless function handler
module.exports = async (req, res) => {
    console.log('Received a request to /api/generate-post');

    // 1. Verify the webhook signature
    try {
        const signature = req.headers['x-hub-signature-256'];
        if (!signature) {
            console.error('Signature missing from request.');
            return res.status(401).send('Unauthorized: Signature missing.');
        }

        const hmac = createHmac('sha256', webhookSecret);
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


    // 2. Check the push event
    const pushRef = req.body.ref;
    console.log(`Push event for ref: ${pushRef}`);
    if (pushRef !== 'refs/heads/main' && pushRef !== 'refs/heads/master') {
        console.log('Push was not to the main branch, skipping.');
        return res.status(200).send('Push was not to the main branch, skipping.');
    }

    try {
        console.log('Starting post generation process...');

        // 3. Get the SHA of the latest commit
        const { data: refData } = await octokit.git.getRef({
            owner,
            repo,
            ref: 'heads/main',
        });
        const latestCommitSha = refData.object.sha;
        console.log(`Latest commit SHA on main branch is: ${latestCommitSha}`);

        // 4. Fetch ideas.md content
        console.log('Fetching ideas.md...');
        const { data: ideasFile } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'ideas.md',
            ref: latestCommitSha,
        });
        const ideasContent = Buffer.from(ideasFile.content, 'base64').toString('utf8');
        console.log(`ideas.md content fetched (length: ${ideasContent.length}).`);

        // 5. Fetch existing posts
        console.log('Fetching existing posts from public/posts...');
        const { data: existingPosts } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'public/posts',
            ref: latestCommitSha,
        });
        const existingPostFiles = existingPosts.map(file => file.name);
        console.log(`Found ${existingPostFiles.length} existing posts:`, existingPostFiles);

        // 6. Parse ideas and identify new ones
        const newIdeas = parseIdeas(ideasContent, existingPostFiles);
        if (newIdeas.length === 0) {
            console.log('No new ideas to process.');
            return res.status(200).send('No new ideas found.');
        }
        console.log(`Found ${newIdeas.length} new ideas to process:`, newIdeas.map(i => i.topic));

        // 7. Generate posts for new ideas
        const newFilesToCommit = [];
        const { data: templateFile } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'templates/post-template.html',
            ref: latestCommitSha,
        });
        const postTemplate = Buffer.from(templateFile.content, 'base64').toString('utf8');
        console.log('Post template fetched successfully.');

        for (const idea of newIdeas) {
            console.log(`--- Generating post for: ${idea.topic} ---`);
            const prompt = `You are an expert blog writer...`; // Keeping it short for the log

            console.log(`Calling Gemini API for topic: ${idea.topic}`);
            const model = genAI.getGenerativeModel({ model: "gemini-pro" });
            const result = await model.generateContent(prompt); // Full prompt is still used here
            const response = await result.response;
            const generatedHtml = response.text();
            console.log(`Gemini API call successful for topic: ${idea.topic}`);

            const postContent = postTemplate
                .replace('{{POST_TITLE}}', idea.topic)
                .replace('{{POST_CONTENT}}', generatedHtml);

            newFilesToCommit.push({
                path: `public/posts/${idea.filename}`,
                content: postContent,
            });
            console.log(`Created content for ${idea.filename}`);
        }

        if (newFilesToCommit.length === 0) {
            console.log('Although there were new ideas, no files were generated to commit.');
            return res.status(200).send('No new posts were generated.');
        }

        // 8. Update index.html
        console.log('Updating index.html...');
        const { data: updatedPosts } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'public/posts',
            ref: latestCommitSha,
        });
        const allPostFiles = [...updatedPosts.map(p => p.name), ...newIdeas.map(i => i.filename)];
        const uniquePostFiles = [...new Set(allPostFiles)];
        const postLinks = uniquePostFiles
            .map(filename => `<li><a href="posts/${filename}">${filename.replace('.html', '').replace(/-/g, ' ')}</a></li>`)
            .join('\n');

        const { data: indexFile } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'public/index.html',
            ref: latestCommitSha,
        });
        const indexContent = Buffer.from(indexFile.content, 'base64').toString('utf8');
        const updatedIndexContent = indexContent.replace('<!-- POSTS_LIST -->', `<ul>\n${postLinks}\n</ul>`);

        newFilesToCommit.push({
            path: 'public/index.html',
            content: updatedIndexContent,
        });
        console.log('index.html updated and added to commit list.');
        console.log(`${newFilesToCommit.length} files are ready to be committed.`);

        // 9. Commit new files to GitHub
        console.log('Starting commit process...');
        const { data: latestCommit } = await octokit.git.getCommit({ owner, repo, commit_sha: latestCommitSha });
        const baseTreeSha = latestCommit.tree.sha;
        console.log(`Base tree SHA: ${baseTreeSha}`);

        const blobs = await Promise.all(
            newFilesToCommit.map(file =>
                octokit.git.createBlob({ owner, repo, content: file.content, encoding: 'utf-8' })
                    .then(blob => {
                        console.log(`Blob created for ${file.path} (SHA: ${blob.data.sha})`);
                        return { path: file.path, mode: '100644', type: 'blob', sha: blob.data.sha };
                    })
            )
        );

        const { data: newTree } = await octokit.git.createTree({ owner, repo, base_tree: baseTreeSha, tree: blobs });
        console.log(`New tree created (SHA: ${newTree.sha})`);

        const { data: newCommit } = await octokit.git.createCommit({
            owner,
            repo,
            message: 'feat: Add new blog posts from ideas.md',
            tree: newTree.sha,
            parents: [latestCommitSha],
        });
        console.log(`New commit created (SHA: ${newCommit.sha})`);

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

// Helper functions (unchanged)
function slugify(text) {
    return text.toString().toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^\w\-]+/g, '')
        .replace(/\-\-+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '');
}

function parseIdeas(content, existingPostFiles) {
    const ideas = content.split('---').filter(idea => idea.trim() !== '');
    const newIdeas = [];
    for (const idea of ideas) {
        const topicMatch = idea.match(/TOPIC:\s*(.*)/i); // Case-insensitive
        const analysisMatch = idea.match(/ANALYSIS:\s*([\s\S]*)/i); // Case-insensitive
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

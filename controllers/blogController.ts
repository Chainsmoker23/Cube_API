import * as express from 'express';
import { supabaseAdmin } from '../supabaseClient';
import { customAlphabet } from 'nanoid';

const nanoid = customAlphabet('1234567890abcdefghijklmnopqrstuvwxyz', 10);
const BUCKET_NAME = 'blog-images';

// Helper to generate a URL-friendly slug
const createSlug = async (title: string, currentId?: string): Promise<string> => {
    console.log(`[Blog Slug] Generating slug for title: "${title}"`);
    let slug = title.toLowerCase()
        .replace(/\s+/g, '-') // Replace spaces with -
        .replace(/[^\w\-]+/g, '') // Remove all non-word chars
        .replace(/\-\-+/g, '-') // Replace multiple - with single -
        .replace(/^-+/, '') // Trim - from start of text
        .replace(/-+$/, ''); // Trim - from end of text
    
    // Check for uniqueness
    let query = supabaseAdmin.from('blog_posts').select('slug').eq('slug', slug);
    if (currentId) {
        query = query.neq('id', currentId);
    }
    const { data, error } = await query.limit(1).single();

    if (error && error.code !== 'PGRST116') { // Ignore "No rows found" error
        console.error('[Blog Slug] DB error checking for slug uniqueness:', error);
        throw error;
    }

    if (data) { // Slug exists, append a unique ID
        const uniqueSuffix = nanoid(4);
        console.log(`[Blog Slug] Slug "${slug}" exists. Appending suffix: "${uniqueSuffix}"`);
        slug = `${slug}-${uniqueSuffix}`;
    } else {
        console.log(`[Blog Slug] Slug "${slug}" is unique.`);
    }

    return slug;
};


// --- Public Controllers ---

export const getPublishedPosts = async (req: express.Request, res: express.Response) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('blog_posts')
            .select('*')
            .eq('is_published', true)
            .order('published_at', { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};

export const getPostBySlug = async (req: express.Request, res: express.Response) => {
    try {
        const { slug } = req.params;
        const { data, error } = await supabaseAdmin
            .from('blog_posts')
            .select('*')
            .eq('slug', slug)
            .eq('is_published', true)
            .single();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Post not found.' });
        res.json(data);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};


// --- Admin Controllers ---

export const getAdminPosts = async (req: express.Request, res: express.Response) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('blog_posts')
            .select('*')
            .order('created_at', { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};

export const createPost = async (req: express.Request, res: express.Response) => {
    console.log('[Blog Create] Received request to create post.');
    try {
        const { title, content, feature_image_url, author_name, is_published, meta_description, meta_keywords } = req.body;
        console.log('[Blog Create] Request body:', req.body);
        
        const slug = await createSlug(title);
        
        const postData = {
            title, content, slug, feature_image_url, author_name, is_published, meta_description, meta_keywords,
            published_at: is_published ? new Date().toISOString() : null
        };
        console.log('[Blog Create] Data prepared for insertion:', postData);
        
        const { data, error } = await supabaseAdmin.from('blog_posts').insert(postData).select().single();
        if (error) {
            console.error('[Blog Create] Supabase insert error:', error);
            throw error;
        }

        console.log('[Blog Create] Post created successfully. ID:', data.id);
        res.status(201).json(data);
    } catch (err: any) {
        console.error('[Blog Create] CATCH BLOCK: An error occurred:', err);
        res.status(500).json({ error: err.message });
    }
};

export const updatePost = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    console.log(`[Blog Update] Received request to update post ID: ${id}`);
    try {
        const { title, content, feature_image_url, author_name, is_published, meta_description, meta_keywords } = req.body;
        console.log('[Blog Update] Request body:', req.body);
        
        const { data: existingPost, error: fetchError } = await supabaseAdmin.from('blog_posts').select('is_published, published_at').eq('id', id).single();
        if (fetchError) {
             console.error(`[Blog Update] Error fetching existing post ${id}:`, fetchError);
            throw fetchError;
        }
        console.log(`[Blog Update] Existing post status: is_published=${existingPost.is_published}, published_at=${existingPost.published_at}`);

        let published_at = existingPost.published_at;
        
        if (is_published && !existingPost.is_published) {
            published_at = new Date().toISOString();
            console.log('[Blog Update] State change: Draft -> Published. Setting new published_at:', published_at);
        } 
        else if (!is_published) {
            published_at = null;
            console.log('[Blog Update] State change: Post is now a draft. Clearing published_at.');
        } else {
             console.log('[Blog Update] State change: No change in published status.');
        }

        const slug = await createSlug(title, id);
        const postData = { title, content, slug, feature_image_url, author_name, is_published, meta_description, meta_keywords, published_at };
        console.log('[Blog Update] Data prepared for update:', postData);

        const { data, error } = await supabaseAdmin.from('blog_posts').update(postData).eq('id', id).select().single();
        if (error) {
            console.error(`[Blog Update] Supabase update error for post ${id}:`, error);
            throw error;
        }

        console.log(`[Blog Update] Post ${id} updated successfully.`);
        res.json(data);
    } catch (err: any) {
        console.error(`[Blog Update] CATCH BLOCK: An error occurred for post ${id}:`, err);
        res.status(500).json({ error: err.message });
    }
};

export const deletePost = async (req: express.Request, res: express.Response) => {
    try {
        const { id } = req.params;
        const { error } = await supabaseAdmin.from('blog_posts').delete().eq('id', id);
        if (error) throw error;
        res.status(204).send();
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
};

export const uploadImageHandler = async (req: express.Request, res: express.Response) => {
    console.log('[Blog Upload] Received request to upload image directly.');
    try {
        const { fileName, fileType, base64Data } = req.body;
        if (!fileName || !fileType || !base64Data) {
            return res.status(400).json({ error: 'fileName, fileType, and base64Data are required.' });
        }
        
        // Convert base64 to a buffer
        const buffer = Buffer.from(base64Data, 'base64');
        
        const filePath = `${nanoid()}-${fileName}`;
        console.log(`[Blog Upload] Uploading to path: ${filePath}`);

        const { error } = await supabaseAdmin.storage
            .from(BUCKET_NAME)
            .upload(filePath, buffer, {
                contentType: fileType,
                upsert: true,
            });

        if (error) {
            console.error('[Blog Upload] Supabase upload error:', error);
            throw error;
        }

        const { data: { publicUrl } } = supabaseAdmin.storage.from(BUCKET_NAME).getPublicUrl(filePath);
        console.log(`[Blog Upload] Upload successful. Public URL: ${publicUrl}`);

        res.json({ publicUrl });
    } catch (err: any) {
        console.error('[Blog Upload] CATCH BLOCK: An error occurred:', err);
        res.status(500).json({ error: err.message });
    }
};
